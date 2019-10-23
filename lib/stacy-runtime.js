"use strict";
/*
 * Copyright 2019 Boyle Software, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const mime = require("mime");
const marked = require("marked");
const { documentToHtmlString } = require("@contentful/rich-text-html-renderer");
const { BLOCKS, INLINES } = require("@contentful/rich-text-types");

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
      directAssets: (options && options.directAssets ? true : false)
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

  //////////////////////////////////////////////////////////////////////////////
  function moduleHelper(moduleLink) {
    if (
      !moduleLink || !moduleLink.sys || moduleLink.sys.type !== "Link" ||
      moduleLink.sys.linkType !== "Entry"
    ) {
      throw new Error("Invalid template: helper \"module\" was passed" +
        " an invalid Entry link object.");
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
  templatesEngine.registerHelper("module", moduleHelper);

  //////////////////////////////////////////////////////////////////////////////
  function resolveAssetLink(assetLink) {
    if (
      !assetLink || !assetLink.sys || assetLink.sys.type !== "Link" ||
      assetLink.sys.linkType !== "Asset"
    ) {
      throw new Error("Invalid template: helper \"assetSrc\" was passed" +
        " an invalid Asset link object.");
    }
    const asset = templatesCtx.linked.assets[assetLink.sys.id];
    if (!asset) {
      throw new Error(`Linked asset id ${assetLink.sys.id}` +
        " is not included in the content.");
    }
    return asset;
  }
  function getAssetUrl(asset) {
    const assetUrl = asset.fields.file.url;
    return (
      templatesCtx.directAssets ?
        assetUrl :
        `/${config.assetsPath}${assetUrl.substring(assetUrl.lastIndexOf("/"))}`
    );
  }
  function assetSrcHelper(assetLink) {
    return getAssetUrl(resolveAssetLink(assetLink));
  }
  templatesEngine.registerHelper("assetSrc", assetSrcHelper);

  //////////////////////////////////////////////////////////////////////////////
  function assetHelper(assetLink) {
    const asset = resolveAssetLink(assetLink);
    const assetSrc = getAssetUrl(asset);
    const contentType = asset.fields.file.contentType;
    if (/^image\//.test(contentType)) {
      return `<img src="${assetSrc}" alt="${asset.fields.title}">`;
    }
    // TODO: implement more types (e.g. video, audio, etc.)
    else {
      throw new Error("Invalid template:" +
        ` unsupported asset content type "${contentType}".`);
    }
  }
  templatesEngine.registerHelper("asset", assetHelper);

  //////////////////////////////////////////////////////////////////////////////
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
  function markdownHelper(content) {
    if (content) {
      return marked(content, { renderer: markedRenderer });
    }
  }
  templatesEngine.registerHelper("markdown", markdownHelper);

  //////////////////////////////////////////////////////////////////////////////
  const documentToHtmlStringOptions = {
    renderNode: {
      [BLOCKS.EMBEDDED_ASSET]: node => assetHelper(node.data.target),
      [INLINES.ASSET_HYPERLINK]: node => (
        `<a href="${assetSrcHelper(node.data.target)}">` +
        `${documentToHtmlString(node, documentToHtmlStringOptions)}` +
        `</a>`
      ),
      [BLOCKS.EMBEDDED_ENTRY]: node => moduleHelper(node.data.target),
      [INLINES.EMBEDDED_ENTRY]: node => moduleHelper(node.data.target),
      [INLINES.ENTRY_HYPERLINK]: () => ""
    }
  };
  function richTextHelper(document) {
    if (!document.nodeType || document.nodeType !== "document") {
      throw new Error("Invalid template: helper \"richText\" was passed" +
        " an invalid rich text document.");
    }
    return documentToHtmlString(document, documentToHtmlStringOptions);
  }
  templatesEngine.registerHelper("richText", richTextHelper);

  //////////////////////////////////////////////////////////////////////////////
  templatesEngine.registerHelper("json", function(data) {
    return JSON.stringify(data, null, "  ");
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

  const involvedEntryIds = collectLinkedEntries(
    new Set(), linkedEntries, pageEntry
  );
  involvedEntryIds.delete(pageEntryId);

  const pages = [];
  for (const ext of Object.keys(templatesBag)) {
    const templates = templatesBag[ext];
    const template = templates[pageEntryType];
    if (template) {
      templatesCtx.ext = ext;
      pages.push({
        pageEntryId,
        involvedEntryIds: Array.from(involvedEntryIds),
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
