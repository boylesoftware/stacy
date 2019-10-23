"use strict";

const path = require("path");
const child_process = require("child_process");
const fse = require("fs-extra");
const Handlebars = require("handlebars");

const OPERATIONS = [
  {
    dst: ".editorconfig",
    src: "dot-editorconfig",
    handler: opCopy
  },
  {
    dst: ".env",
    src: "dot-env",
    handler: opTemplate
  },
  {
    dst: ".gitignore",
    src: "dot-gitignore",
    handler: opCopy
  },
  {
    dst: "package.json",
    src: "package.json",
    handler: opTemplate
  },
  {
    dst: "stacy.json",
    src: "stacy.json",
    handler: opTemplate
  },
  {
    dst: "misc/cfn-template.json",
    src: "cfn-template.json",
    handler: opTemplate
  },
  {
    dst: "static/favicon.ico",
    src: "favicon.ico",
    handler: opCopy
  },
  {
    dst: "static/styles.css",
    src: "styles.css",
    handler: opCopy
  },
  {
    dst: "templates/page.hbs",
    src: "page.hbs",
    handler: opCopy
  },
];

function opCopy(op, srcDir, dstDir) {
  return fse.copy(path.resolve(srcDir, op.src), path.resolve(dstDir, op.dst));
}

function opTemplate(op, srcDir, dstDir, options) {
  return fse.ensureDir(path.resolve(dstDir, op.dst, ".."))
  .then(() => fse.readFile(path.resolve(srcDir, op.src), "utf8"))
  .then(tmpl => Handlebars.compile(tmpl)(options))
  .then(data => fse.writeFile(path.resolve(dstDir, op.dst), data, "utf8"));
}

exports.GLOBAL = true;

exports.execute = async function(options) {

  const dstDir = path.resolve(options.siteId);
  const srcDir = path.resolve(__dirname, "../grub");

  // create project directory
  let chain = fse.mkdir(dstDir);

  // create initial project files
  for (const op of OPERATIONS) {
    chain = chain.then(() => {
      console.log(`generating ${op.dst}...`);
      return op.handler(op, srcDir, dstDir, options);
    });
  }

  // install packages
  chain = chain.then(() => new Promise((resolve, reject) => {
    console.log("installing packages...");
    child_process.spawn(
      "npm", ["install"],
      {
        cwd: dstDir,
        stdio: "inherit"
      }
    )
    .on("error", err => {
      reject(err);
    })
    .on("exit", exitCode => {
      if (exitCode === 0) {
        resolve();
      }
      else {
        reject(`NPM finished with exit code ${exitCode}.`);
      }
    });
  }));

  // done
  return chain.then(() => {
    console.log("your new project is ready!");
  });
};
