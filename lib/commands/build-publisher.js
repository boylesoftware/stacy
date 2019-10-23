"use strict";

const child_process = require("child_process");
const path = require("path");
const fse = require("fs-extra");
const archiver = require("archiver");

const common = require("../common.js");

const pkg = require("../../package.json");

function* templatesFileChunks(templatesBag) {
  yield "module.exports = {";
  const exts = Object.keys(templatesBag);
  for (let i = 0, leni = exts.length; i < leni; i++) {
    const ext = exts[i];
    if (i === 0) {
      yield `\n  "${ext}": {`;
    }
    else {
      yield `,\n  "${ext}": {`;
    }
    const templates = templatesBag[ext];
    const entryTypes = Object.keys(templates);
    for (let j = 0, lenj = entryTypes.length; j < lenj; j++) {
      const entryType = entryTypes[j];
      if (j === 0) {
        yield `\n    "${entryType}": `;
      }
      else {
        yield `,\n    "${entryType}": `;
      }
      yield templates[entryType];
    }
    yield "\n  }";
  }
  yield "\n};\n";
}

function writeTemplatesFileChunks(out, chunks) {
  let chunk, writeMore = false;
  do {
    chunk = chunks.next().value;
    if (chunk) {
      writeMore = out.write(chunk, "utf8");
    }
  } while (chunk && writeMore);
  if (chunk) {
    out.once("drain", () => writeTemplatesFileChunks(out, chunks));
  }
  else {
    out.end();
  }
}

exports.execute = async function(projectDir, config) {

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
    for (const templatePath of templatePaths) {
      chain = chain.then(templatesBag => common.loadTemplate(
        templatesEngine, templatesDir, templatePath, templatesBag, {
          precompile: true
        }
      ));
    }
    return chain;
  })

  // save pre-compiled templates
  .then(templatesBag => new Promise((resolve, reject) => {
    console.log("writing precompiled templates file...");
    const fs = fse.createWriteStream(path.resolve(workDir, "templates.js"));
    fs.on("error", err => {
      fs.destroy();
      reject(err);
    });
    fs.on("finish", () => {
      resolve();
    });
    writeTemplatesFileChunks(fs, templatesFileChunks(templatesBag));
  }))

  // copy Lambda function body over
  .then(() => {
    console.log("copying rest of the package over...");
    return fse.copyFile(
      path.resolve(__dirname, "../publisher/index.js"),
      path.resolve(workDir, "index.js")
    );
  })

  // copy Stacy runtime over
  .then(() => fse.copyFile(
    path.resolve(__dirname, "../stacy-runtime.js"),
    path.resolve(workDir, "stacy-runtime.js")
  ))

  // copy Handlebars runtime over
  .then(() => fse.copyFile(
    path.resolve(
      __dirname,
      "../../node_modules/handlebars/dist/handlebars.runtime.min.js"
    ),
    path.resolve(workDir, "handlebars-runtime.js")
  ))

  // save site config
  .then(() => fse.writeFile(
    path.resolve(workDir, "stacy.json"),
    JSON.stringify(config, null, "  "),
    "utf8"
  ))

  // create package.json
  .then(() => fse.writeFile(
    path.resolve(workDir, "package.json"),
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
    child_process.spawn(
      "npm", ["install", "--production", "--no-package-lock"],
      {
        cwd: workDir,
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
  }))

  // create package zip
  .then(() => new Promise((resolve, reject) => {
    const fileName = `stacy-${config.siteId}-publisher.zip`;
    console.log(`creating package archive ${fileName}...`);
    const out = fse.createWriteStream(
      path.resolve(projectDir, "dist", fileName)
    );
    const archive = archiver("zip");
    out.on("close", () => {
      resolve();
    });
    archive.on("error", err => {
      reject(err);
    });
    archive.on("warning", err => {
      reject(err);
    });
    archive.pipe(out);
    archive.directory(workDir, false);
    archive.finalize();
  }));
};
