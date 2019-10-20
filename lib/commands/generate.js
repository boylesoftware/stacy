"use strict";

const fse = require("fs-extra");

const common = require("../common.js");
const stacy = require("../stacy-runtime.js");

// TODO: support downloading assets via a command line option

exports.execute = function(projectDir, config, env) {

  const staticDir = `${projectDir}/${config.staticDir}`;
  const templatesDir = `${projectDir}/${config.templatesDir}`;
  const outputDir = `${projectDir}/dist/site`;

  const cfClient = common.createContentfulClient(env);
  const templatesEngine = common.createTemplatesEngine();

  const templatesBag = {};

  // prepare site output directory
  console.log("clearing site output directory...");
  return fse.emptyDir(outputDir)

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
      chain = chain.then(() => cfClient.getEntries(Object.assign({}, cfQuery, {
        content_type: pageContentType
      }))).then(result => {
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
            publishPage(page) {
              console.log(`saving generated page id ${page.pageEntryId}` +
                ` at ${page.publishPath}...`);
              const path = `${outputDir}/${page.publishPath}`;
              return fse.ensureDir(path.substring(0, path.lastIndexOf("/")))
              .then(() => fse.writeFile(path, page.content));
            }
          }, {
            directAssets: true
          }
        );
      });
    }
    return chain;
  });
}