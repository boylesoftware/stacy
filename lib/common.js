"use strict";

const contentful = require("contentful");
const Handlebars = require("handlebars");

exports.createContentfulClient = function(env) {
  return contentful.createClient({
    space: env["CF_SPACE"],
    accessToken: env["CF_ACCESS_TOKEN"],
    host: env["CF_HOST"] || "cdn.contentful.com",
    environment: env["CF_ENVIRONMENT"] || "master",
    resolveLinks: false
  });
};

exports.TEMPLATE_FILE_PATTERN = /\.(?:hbs|handlebars)$/i;

exports.createTemplatesEngine = function() {
  return Handlebars.create();
};
