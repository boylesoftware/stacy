"use strict";

const fse = require("fs-extra");
const mime = require("mime");
const contentful = require("contentful");
const Handlebars = require("handlebars");

exports.isEmpty = function(str) {
  return typeof str !== "string" || /^\s*$/.test(str);
};

exports.createContentfulClient = function(env) {
  return contentful.createClient({
    space: env["CF_SPACE"],
    accessToken: env["CF_ACCESS_TOKEN"],
    host: env["CF_HOST"] || "cdn.contentful.com",
    environment: env["CF_ENVIRONMENT"] || "master",
    resolveLinks: false
  });
};

exports.createTemplatesEngine = function() {
  return Handlebars.create();
};

function isTemplatePath(path) {
  return /\.(?:hbs|handlebars)$/i.test(path);
}
exports.isTemplatePath = isTemplatePath;

function parseTemplatePath(path, templatesDir, templatesBag) {

  const m = path.match(/([^/]*?)(?:\.([^.]+))?\.[^.]+$/);

  const ext = m[2] || "html";
  let templates = templatesBag[ext];
  if (!templates) {
    templates = {};
    templatesBag[ext] = templates;
  }

  return {
    relPath: path.substring(templatesDir.length),
    entryType: m[1],
    ext,
    templates
  };
}
exports.parseTemplatePath = parseTemplatePath;

function findTemplates(dir, templatePaths) {
  return fse.readdir(dir, { withFileTypes: true }).then(files => {
    let subdirsChain;
    for (const file of files) {
      if (file.isDirectory()) {
        if (subdirsChain) {
          subdirsChain = subdirsChain.then(
            () => findTemplates(`${dir}/${file.name}`, templatePaths));
        }
        else {
          subdirsChain = findTemplates(`${dir}/${file.name}`, templatePaths);
        }
      }
      else if (isTemplatePath(file.name)) {
        templatePaths.push(`${dir}/${file.name}`);
      }
    }
    return subdirsChain;
  });
}
exports.findTemplates = findTemplates;

exports.loadTemplate = function(
  templatesEngine, templatesDir, path, templatesBag, options
) {

  // parse template path
  const { relPath, entryType, ext, templates } = parseTemplatePath(
    path, templatesDir, templatesBag
  );

  // validate template target extension
  if (!mime.getType(ext)) {
    throw `Template ${relPath} is for invalid extenstion.`;
  }

  // verify template target uniqueness
  if (templates[entryType] !== undefined) {
    throw `More than one "${ext}" template found for type "${entryType}".`;
  }

  // load and compile the template
  console.log(`loading "${ext}" template for "${entryType}" at ${relPath}...`);
  return fse.readFile(path, "utf8")
  .then(templateData => {
    templates[entryType] = (
      options && options.precompile ?
        templatesEngine.precompile(templateData) :
        templatesEngine.compile(templateData)
    );
  })
  .then(() => templatesBag);
};
