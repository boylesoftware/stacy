"use strict";

const child_process = require("child_process");
const fse = require("fs-extra");
const archiver = require("archiver");

const common = require("../common.js");

const pkg = require("../../package.json");

exports.execute = function(projectDir, config) {

  const templatesDir = `${projectDir}/${config.templatesDir}`;
  const workDir = `${projectDir}/dist/publisher`;

  const templatesEngine = common.createTemplatesEngine();

  // prepare publisher package directory
  console.log("clearing publisher package directory...");
  return fse.emptyDir(workDir)

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

  // pre-compile templates
  .then(templatePaths => {
    let chain = Promise.resolve({});
    for (const path of templatePaths) {
      chain = chain.then(templatesBag => common.loadTemplate(
        templatesEngine, templatesDir, path, templatesBag, {
          precompile: true
        }
      ));
    }
    return chain;
  })

  // save pre-compiled templates
  .then(templatesBag => fse.writeFile(
    `${workDir}/templates.json`,
    JSON.stringify(templatesBag, null, "  "),
    "utf8")
  )

  // copy Lambda function body over
  .then(() => {
    console.log("copying rest of the package over...");
    return fse.copyFile(
      `${__dirname}/../publisher/index.js`,
      `${workDir}/index.js`
    );
  })

  // copy Stacy runtime over
  .then(() => fse.copyFile(
    `${__dirname}/../stacy-runtime.js`,
    `${workDir}/stacy-runtime.js`
  ))

  // copy Handlebars runtime over
  .then(() => fse.copyFile(
    `${__dirname}/../../node_modules/handlebars/dist/handlebars.runtime.min.js`,
    `${workDir}/handlebars-runtime.js`
  ))

  // save site config
  .then(() => fse.writeFile(
    `${workDir}/stacy.json`, JSON.stringify(config, null, "  "), "utf8"
  ))

  // create package.json
  .then(() => fse.writeFile(
    `${workDir}/package.json`,
    JSON.stringify(
      {
        name: `stacy-${config.siteId}-publisher`,
        private: true,
        dependencies: {
          "contentful": pkg.dependencies["contentful"],
          "marked": pkg.dependencies["marked"],
          "mime": pkg.dependencies["mime"]
        }
      },
      null, "  "
    ),
    "utf8"
  ))

  // install dependencies
  .then(() => new Promise((resolve, reject) => {
    console.log("installing dependencies...");
    const npm = child_process.spawn(
      "npm", ["install", "--production", "--no-package-lock"],
      {
        cwd: workDir,
        stdio: "inherit"
      }
    );
    npm.on("error", err => {
      reject(err);
    });
    npm.on("exit", exitCode => {
      if (exitCode === 0) {
        resolve();
      }
      else {
        reject(`NPM finished with exit code ${exitCode}.`);
      }
    });
  }))

  // create package zip
  .then(() => new Promise((resolve, reject) => {
    console.log("creating package archive...");
    const archive = archiver("zip");
    archive.on("close", () => {
      resolve();
    });
    archive.on("error", err => {
      reject(err);
    });
    archive.on("warning", err => {
      reject(err);
    });
    archive.pipe(fse.createWriteStream(
      `${projectDir}/dist/stacy-${config.siteId}-publisher.zip`
    ));
    archive.directory(workDir, false);
    archive.finalize();
  }));
};
