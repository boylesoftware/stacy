"use strict";

const https = require("https");
const fse = require("fs-extra");

const common = require("../common.js");
const stacy = require("../stacy-runtime.js");

function publishPage(outputDir, metaItems, page) {

  console.log(`saving generated page id ${page.pageEntryId}` +
    ` at ${page.publishPath}...`);

  // update site metadata
  metaItems[page.pageEntryId] = {
    Id: { S: page.pageEntryId },
    PublishPath: { S: page.publishPath },
    UsedEntryIds: { SS: page.involvedEntryIds }
  };
  for (const usedEntryId of page.involvedEntryIds) {
    let item = metaItems[usedEntryId];
    if (!item) {
      item = {
        Id: { S: usedEntryId },
        PageEntryIds: { SS: [] }
      };
      metaItems[usedEntryId] = item;
    }
    item.PageEntryIds.SS.push(page.pageEntryId);
  }

  // save generated page
  const path = `${outputDir}/${page.publishPath}`;
  return fse.ensureDir(path.substring(0, path.lastIndexOf("/")))
  .then(() => fse.writeFile(path, page.content));
}

exports.REQUIRED_ENV = [
  "CF_SPACE",
  "CF_ACCESS_TOKEN"
];

exports.execute = function(projectDir, config, env, cmd) {

  const staticDir = `${projectDir}/${config.staticDir}`;
  const templatesDir = `${projectDir}/${config.templatesDir}`;
  const outputDir = `${projectDir}/dist/site`;

  const cfClient = common.createContentfulClient(env);
  const templatesEngine = common.createTemplatesEngine();

  const templatesBag = {};

  const metaItems = {};

  // prepare site output directory
  console.log("clearing site output directory...");
  let resultPromise = fse.emptyDir(outputDir)

  // copy static content over if any
  .then(() => fse.stat(staticDir))
  .catch(statErr => (
    statErr.code === "ENOENT" ? null : Promise.reject(statErr))
  )
  .then(staticDirStats => {
    if (staticDirStats && staticDirStats.isDirectory()) {
      console.log("copying static content...");
      // TODO: filter out unnecessary files (backups, temps, system, etc.)
      return fse.copy(staticDir, outputDir);
    }
  })

  // find all templates
  .then(() => fse.stat(templatesDir))
  .catch(statErr => (
    statErr.code === "ENOENT" ? null : Promise.reject(statErr))
  )
  .then(templatesDirStats => {
    if (!templatesDirStats || !templatesDirStats.isDirectory()) {
      throw `Templates directory not found at ${templatesDir}.`;
    }
    const templatePaths = [];
    return common.findTemplates(templatesDir, templatePaths).then(
      () => templatePaths
    );
  })

  // compile templates
  .then(templatePaths => {
    let chain = Promise.resolve();
    for (const path of templatePaths) {
      chain = chain.then(() => common.loadTemplate(
        templatesEngine, templatesDir, path, templatesBag
      ));
    }
    return chain;
  })

  // get ids of all top website page entries
  .then(() => {
    // TODO: handle if more than 1000 entries
    const cfQuery = {
      select: `sys.id,fields.${config.pageSlugField}`,
      limit: 1000
    };
    const seenSlugs = new Set();
    const pageEntryIds = [];
    let chain = Promise.resolve();
    for (const pageContentType of config.pageContentTypes) {
      chain = chain.then(() => {
        console.log(`looking up all pages of type "${pageContentType}"...`);
        return cfClient.getEntries(Object.assign({}, cfQuery, {
          content_type: pageContentType
        }));
      }).then(result => {
        for (const pageEntry of result.items) {
          const fields = pageEntry.fields;
          const slug = fields && fields[config.pageSlugField];
          if (typeof slug !== "string") {
            return Promise.reject(`Page entry id ${pageEntry.sys.id}` +
              " does not have a slug or its value is not a string.");
          }
          if (seenSlugs.has(slug)) {
            return Promise.reject(`Page entry id ${pageEntry.sys.id}` +
              ` has slug "${slug}" that is used by another page.`);
          }
          seenSlugs.add(slug);
          pageEntryIds.push(pageEntry.sys.id);
        }
      });
    }
    return chain.then(() => pageEntryIds);
  })

  // generate and save pages
  .then(pageEntryIds => {
    if (pageEntryIds.length === 0) {
      console.log("did not find any pages");
      return;
    }
    let chain = Promise.resolve();
    const batches = [];
    let batch = [];
    batches.push(batch);
    for (const pageEntryId of pageEntryIds) {
      if (batch.length === 5) {
        batch = [];
        batches.push(batch);
      }
      batch.push(pageEntryId);
    }
    for (const batch of batches) {
      chain = chain.then(() => {
        console.log(`generating page ids ${batch.join(", ")}...`);
        return stacy.fetchContentAndGeneratePages(
          batch, config, cfClient, templatesEngine, templatesBag, {
            publishPage: page => publishPage(outputDir, metaItems, page)
          }, {
            directAssets: !cmd.withAssets
          }
        );
      });
    }
    return chain;
  });

  // download assets
  if (cmd.withAssets) {

    const assetsDir = `${outputDir}/${config.assetsPath}`;

    // create assets target directory
    resultPromise = resultPromise.then(() => fse.ensureDir(assetsDir))

    // get all published assets
    .then(() => {
      console.log("looking up all assets...");
      // TODO: handle if more than 1000 assets
      return cfClient.getAssets({
        limit: 1000
      });
    })

    // process assets
    .then(result => {
      if (result.items.length === 0) {
        console.log("no assets found");
      }
      else {
        let chain = Promise.resolve();
        for (const asset of result.items) {

          const assetUrl = `https:${asset.fields.file.url}`;
          const fileName = assetUrl.substring(assetUrl.lastIndexOf("/") + 1);

          // update site metadata
          metaItems[asset.sys.id] = {
            Id: { S: asset.sys.id },
            FileNames: { SS: [fileName] }
          };

          // download asset
          chain = chain.then(() => new Promise((resolve, reject) => {
            console.log(`downloading asset ${fileName}` +
              ` (${asset.fields.file.details.size} bytes)...`);
            https.get(assetUrl, res => {
              const statusCode = res.statusCode;
              if (statusCode !== 200) {
                res.resume();
                reject(new Error(
                  `Failed to download asset with status code ${statusCode}.`));
              }
              else {
                const out = fse.createWriteStream(`${assetsDir}/${fileName}`);
                out.on("finish", () => {
                  resolve();
                });
                out.on("error", err => {
                  reject(err);
                })
                res.pipe(out);
              }
            })
            .on("error", err => {
              reject(err);
            });
          }));
        }
        return chain;
      }
    });
  }

  // write site metadata
  if (cmd.writeMetadata) {

    resultPromise = resultPromise.then(() => {
      console.log("saving site metadata" +
        ` at ${projectDir}/dist/site-metadata.json...`);
      return fse.writeFile(
        `${projectDir}/dist/site-metadata.json`,
        JSON.stringify({
          Items: Object.values(metaItems)
        }, null, "  "),
        "utf8"
      );
    });
  }

  return resultPromise.then(() => {
    console.log("site generation complete");
  });
}
