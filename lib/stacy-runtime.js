"use strict";
// TODO: add license

const mime = require("mime");
const marked = require("marked");

function mapLinked(content) {

  const entries = {};
  if (content.includes && content.includes.Entry) {
    for (const entry of content.includes.Entry) {
      entries[entry.sys.id] = entry;
    }
  }
  const assets = {};
  if (content.includes && content.includes.Asset) {
    for (const asset of content.includes.Asset) {
      assets[asset.sys.id] = asset;
    }
  }

  return {
    entries,
    assets
  };
}

function fetchContentAndGeneratePages(
  pageEntryIds, config, cfClient, templatesEngine, templatesBag, publisher,
  options
) {

  // TODO: handle if more than 1000 entries
  const cfQuery = {
    include: config.maxModuleDepth,
    limit: pageEntryIds.length
  };
  if (pageEntryIds.length === 1) {
    cfQuery["sys.id"] = pageEntryIds[0];
  }
  else {
    cfQuery["sys.id[in]"] = pageEntryIds.join(",");
  }
  return cfClient.getEntries(cfQuery)
  .then(result => {
    const linked = mapLinked(result);
    const templatesCtx = {
      linked,
      directAssets: options.directAssets
    };
    configureTemplatesEngine(
      templatesEngine, config, templatesBag, templatesCtx
    );
    let chain = Promise.resolve();
    if (result.items) {
      for (const pageEntry of result.items) {
        for (const page of generatePages(
          pageEntry, linked.entries, config, templatesBag, templatesCtx
        )) {
          chain = chain.then(() => publisher.publishPage(page));
        }
      }
    }
    return chain;
  });
}

function configureTemplatesEngine(
  templatesEngine, config, templatesBag, templatesCtx
) {

  templatesEngine.registerHelper("module", function(moduleLink) {
    if (moduleLink) {
      if (
        !moduleLink.sys || moduleLink.sys.type !== "Link" ||
        moduleLink.sys.linkType !== "Entry"
      ) {
        throw new Error("Invalid template: helper \"module\" was passed" +
          " invalid Entry link object.");
      }
      const moduleEntry = templatesCtx.linked.entries[moduleLink.sys.id];
      if (moduleEntry) {
        const templates = templatesBag[templatesCtx.ext];
        const moduleEntryType = moduleEntry.sys.contentType.sys.id;
        const moduleTemplate = templates[moduleEntryType];
        if (!moduleTemplate) {
          throw new Error(`No "${templatesCtx.ext}" template found` +
            ` for module type "${moduleEntryType}".`);
        }
        return moduleTemplate(Object.assign({}, moduleEntry.fields, {
          $sys: moduleEntry.sys
        }));
      }
    }
  });

  templatesEngine.registerHelper("assetSrc", function(assetLink) {
    if (
      !assetLink || !assetLink.sys || assetLink.sys.type !== "Link" ||
      assetLink.sys.linkType !== "Asset"
    ) {
      throw new Error("Invalid template: helper \"assetSrc\" was passed" +
        " invalid Asset link object.");
    }
    const asset = templatesCtx.linked.assets[assetLink.sys.id];
    if (!asset) {
      throw new Error(`Linked asset id ${assetLink.sys.id}` +
        " is not included in the content.");
    }
    return (
      templatesCtx.directAssets ?
        asset.fields.file.url :
        `/${config.assetsPath}/${asset.fields.file.fileName}`
    );
  });

  const markedRenderer = new marked.Renderer();
  if (templatesCtx.directAssets) {
    markedRenderer.image = function(href, _, text) {
      return `<img src="${href}" alt="${text}">`;
    };
  }
  else {
    markedRenderer.image = function(href, _, text) {
      const fileName = href.substring(href.lastIndexOf("/") + 1);
      return `<img src="/${config.assetsPath}/${fileName}" alt="${text}">`;
    };
  }
  templatesEngine.registerHelper("markdown", function(content) {
    if (content) {
      return marked(content, { renderer: markedRenderer });
    }
  });

  templatesEngine.registerHelper("richText", function(/*content*/) {
    // TODO: implement
    return "UNIMPLEMENTED";
  });
}

function tryCollectEntryLink(involvedEntryIds, linkedEntries, fieldValue) {

  if (
    fieldValue !== null && typeof fieldValue === "object" &&
    fieldValue.sys &&
    fieldValue.sys.type === "Link" && fieldValue.sys.linkType === "Entry"
  ) {
    const linkedEntry = linkedEntries[fieldValue.sys.id];
    if (linkedEntry === undefined) {
      throw new Error(`Linked entry id ${fieldValue.sys.id}` +
        " is not included in the content.");
    }
    collectLinkedEntries(involvedEntryIds, linkedEntries, linkedEntry);
  }
}

function collectLinkedEntries(involvedEntryIds, linkedEntries, entry) {

  involvedEntryIds.add(entry.sys.id);

  if (entry.fields) {
    for (const fieldName of Object.keys(entry.fields)) {
      const fieldValue = entry.fields[fieldName];
      if (Array.isArray(fieldValue)) {
        for (const fieldItemValue of fieldValue) {
          tryCollectEntryLink(involvedEntryIds, linkedEntries, fieldItemValue);
        }
      }
      else {
        tryCollectEntryLink(involvedEntryIds, linkedEntries, fieldValue);
      }
    }
  }

  return involvedEntryIds;
}

function generatePages(
  pageEntry, linkedEntries, config, templatesBag, templatesCtx
) {

  const pageEntryId = pageEntry.sys.id;
  const pageEntryType = pageEntry.sys.contentType.sys.id;

  const slug = pageEntry.fields[config.pageSlugField];
  if (typeof slug !== "string") {
    throw new Error(`Page entry id ${pageEntryId} does not have a slug` +
      " or its value is not a string.");
  }

  const involvedEntryIds = Array.from(collectLinkedEntries(
    new Set(), linkedEntries, pageEntry
  ));

  const pages = [];
  for (const ext of Object.keys(templatesBag)) {
    const templates = templatesBag[ext];
    const template = templates[pageEntryType];
    if (template) {
      templatesCtx.ext = ext;
      pages.push({
        pageEntryId,
        involvedEntryIds,
        publishPath: `${slug}.${ext}`,
        contentType: mime.getType(ext),
        content: Buffer.from(template(Object.assign({}, pageEntry.fields, {
          $sys: pageEntry.sys
        })), "utf8")
      });
    }
  }

  if (pages.length === 0) {
    throw new Error(`No templates found for page type ${pageEntryType}.`);
  }

  return pages;
}

exports.mapLinked = mapLinked;
exports.configureTemplatesEngine = configureTemplatesEngine;
exports.fetchContentAndGeneratePages = fetchContentAndGeneratePages;
