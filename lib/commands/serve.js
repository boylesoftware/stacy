"use strict";

const http = require("http");
const fse = require("fs-extra");
const chokidar = require("chokidar");
const mime = require("mime");

const common = require("../common.js");
const stacy = require("../stacy-runtime.js");

function errorResponse(res, statusCode, message, headers) {
  res.statusCode = statusCode;
  if (headers) {
    for (const header of Object.keys(headers)) {
      res.setHeader(header, headers[header]);
    }
  }
  res.setHeader("Content-Type", "text/plain; charset=UTF-8");
  res.end(`${http.STATUS_CODES[statusCode]}\n\n${message}`);
}

exports.REQUIRED_ENV = [
  "CF_SPACE",
  "CF_ACCESS_TOKEN"
];

exports.execute = function(projectDir, config, env, cmd) {

  const staticDir = `${projectDir}/${config.staticDir}`;
  const templatesDir = `${projectDir}/${config.templatesDir}`;

  const cfClient = common.createContentfulClient(env);
  const templatesEngine = common.createTemplatesEngine();

  const templatesBag = {};

  let watcher;

  // watch templates for changes
  return new Promise((resolve, reject) => {
    console.log("scanning for templates...");
    let templatesCompileChain = Promise.resolve();
    watcher = chokidar.watch(templatesDir);
    watcher.on("error", err => {
      reject(err);
    });
    watcher.on("ready", () => {
      resolve(templatesCompileChain);
      templatesCompileChain = null;
    });
    watcher.on("all", (event, path) => {
      if (common.isTemplatePath(path)) {
        const { relPath, entryType, templates } = common.parseTemplatePath(
          path, templatesDir, templatesBag
        );
        switch (event) {
        case "add":
        case "change":
          console.log(`loading template at ${relPath}...`);
          if (templatesCompileChain) { // initial load
            templatesCompileChain = templatesCompileChain
            .then(() => fse.readFile(path, "utf8"))
            .then(templateData => {
              templates[entryType] = templatesEngine.compile(templateData);
            });
          }
          else { // modification after initial load
            fse.readFile(path, "utf8")
            .then(templateData => {
              templates[entryType] = templatesEngine.compile(templateData);
            })
            .catch(err => {
              console.error(`Could not load template at ${relPath}`, err);
            });
          }
          break;
        case "unlink":
          console.log(`template deleted at ${relPath}`);
          delete templates[entryType];
        }
      }
    });
  })

  // start HTTP server
  .then(() => new Promise((resolve, reject) => {
    console.log("starting HTTP server...");
    const server = http.createServer((req, res) => {

      console.log(`${req.method} ${req.url}`);

      // check the HTTP method
      // TODO: support OPTIONS
      if (req.method !== "GET" && req.method !== "HEAD") {
        return errorResponse(
          res, 405,
          `HTTP method "${req.method}" is not supported.`,
          {
            "Allow": "GET, HEAD"
          }
        );
      }
      const isHead = req.method === "HEAD";

      // process request URL and get extension and content type
      const url = (req.url === "/" ? "/index.html" : req.url);
      const dotInd = url.lastIndexOf(".");
      const ext = (
        dotInd > 0 && dotInd > url.lastIndexOf("/") ?
          url.substring(dotInd + 1) :
          null
      );
      const resCType = mime.getType(ext);

      // try to find and serve static content
      const staticFilePath = `${staticDir}${url}`;
      fse.stat(staticFilePath).then(

        // found static resource
        stats => {

          // make sure it is not a directory
          if (stats.isDirectory()) {
            return errorResponse(
              res, 404,
              `Request URL "${req.url}" is invalid: static content directory.`
            );
          }

          // send the file
          res.setHeader("Content-Type", resCType || "application/octet-stream");
          res.setHeader("Content-Length", stats.size);
          if (isHead) {
            res.end();
          }
          else {
            fse.createReadStream(staticFilePath).pipe(res);
          }
        },

        // did not find static resource
        err => {

          // check if stat call error
          if (err.code !== "ENOENT") {
            return Promise.reject(err);
          }

          // dynamic page must have extension and known content type
          if (ext === null) {
            return errorResponse(
              res, 404,
              `Request URL "${req.url}" is invalid: missing extension.`
            );
          }
          if (!resCType) {
            return errorResponse(
              res, 404,
              `Request URL "${req.url}" is invalid: invalid extension.`
            );
          }

          // extract the page slug
          const slug = url.substring(1, dotInd);

          // get templates for the extension
          const templates = templatesBag[ext] || {};

          // fetch page content
          let chain = Promise.resolve();
          const cfQuery = {
            include: config.maxModuleDepth,
            limit: 1,
            [`fields.${config.pageSlugField}`]: slug
          };
          for (const pageContentType of config.pageContentTypes) {
            chain = chain.then(result => (
              result && result.items && result.items.length > 0 ?
                result :
                cfClient.getEntries(Object.assign({}, cfQuery, {
                  content_type: pageContentType
                }))
            ));
          }

          // render and serve the page
          return chain.then(content => {

            // make sure we got content for the page
            if (!content || !content.items || content.items.length === 0) {
              return errorResponse(
                res, 404,
                `No page entry found for slug "${slug}".`
              );
            }

            // find matching template
            const pageEntry = content.items[0];
            const pageEntryType = pageEntry.sys.contentType.sys.id;
            const template = templates[pageEntryType];
            if (!template) {
              return errorResponse(
                res, 500,
                `No "${ext}" template for page type "${pageEntryType}".`
              );
            }

            // combine template with the content
            stacy.configureTemplatesEngine(
              templatesEngine, config, templatesBag, {
                ext,
                linked: stacy.mapLinked(content),
                directAssets: true
              }
            );
            const page = template(Object.assign({}, pageEntry.fields, {
              $sys: pageEntry.sys
            }));

            // send the page
            // TODO: add charset for some content types, maybe?
            res.setHeader("Content-Type", resCType);
            if (isHead) {
              res.setHeader("Content-Length", Buffer.byteLength(page, "utf8"));
              res.end();
            }
            else {
              res.end(page);
            }
          })
        }
      )

      // catch error
      .catch(err => {
        console.error("ERROR:", err);
        errorResponse(res, 500, err.stack);
      });
    });

    server.on("error", err => {
      reject(err);
    });

    server.listen(cmd.port, () => {
      console.log(`listening for requests on port ${cmd.port}...`);
      resolve();
    });
  }))

  // close templates watcher on error
  .catch(err => {
    if (watcher) {
      watcher.close();
    }
    return Promise.reject(err);
  });
};
