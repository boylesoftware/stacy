#!/usr/bin/env node

"use strict";

const util = require("util");
const fse = require("fs-extra");
const program = require("commander");
const findUp = require("find-up");
const dotenv = require("dotenv");

const common = require("./common.js");

const pkg = require("../package.json");

const DEFAULT_CONFIG = {
  staticDir: "static",
  templatesDir: "templates",
  pageContentTypes: ["page"],
  maxModuleDepth: 3,
  assetsPath: "assets",
  pageSlugField: "slug"
};

function fatalError(error) {

  let saveErrorDetails = false;

  if (typeof error === "string") {
    console.error(`\nFATAL ERROR: ${error}\n`);
  }
  else if (
    error.response && error.response.headers &&
    error.response.headers["x-contentful-request-id"]
  ) {
    saveErrorDetails = true;
    const res = error.response;
    let message = "\nFATAL ERROR: Contentful error" +
      ` ${res.status} (${res.statusText})\n`;
    if (/json$/.test(res.headers["content-type"])) {
      const data = res.data;
      message += `\n${data.message}\n\n`;
      if (data.details && data.details.errors) {
        message += "Details:\n";
        for (const e of data.details.errors) {
          message += `  ${util.inspect(e)}\n`;
        }
        message += "\n";
      }
    }
    console.error(message);
  }
  else {
    saveErrorDetails = true;
    console.error("\nFATAL ERROR:", error.message || error);
  }

  if (saveErrorDetails) {
    (require("http"))[util.inspect.custom] = () => "[HTTP MODULE]";
    (require("https"))[util.inspect.custom] = () => "[HTTPS MODULE]";
    (require("net")).Socket.prototype[util.inspect.custom] = () => "[SOCKET]";
    const errorDetails = util.inspect(error, {
      showHidden: false,
      depth: Infinity,
      breakLength: 120
    });
    fse.appendFile(
      "stacy-debug.log",
      `>>>>>>>> ${new Date().toISOString()} ERROR DETAILS\n${errorDetails}\n\n`,
      err => {
        if (!err) {
          console.error("Error details saved in stacy-debug.log.\n");
        }
      }
    );
  }

  process.exitCode = 1;
}

function executeCommand(commandName, options) {

  const command = require(`./commands/${commandName}`);

  let resultPromise;

  if (command.GLOBAL) {
    resultPromise = command.execute(options);
  }
  else {
    resultPromise = findUp("stacy.json")
    .then(configPath => {
      if (configPath === undefined) {
        return fatalError("Must be called from a Stacy project directory.");
      }
      const projectDir = configPath.substring(
        0, configPath.length - "/stacy.json".length);
      const config = Object.assign({}, DEFAULT_CONFIG, require(configPath));
      const dotenvResult = dotenv.config({ path: `${projectDir}/.env` });
      if (dotenvResult.error) {
        if (dotenvResult.error.code === "ENOENT") {
          return fatalError("No .env file found in the project directory.");
        }
        return fatalError(dotenvResult.error);
      }
      for (const envVar of command.REQUIRED_ENV || []) {
        if (common.isEmpty(process.env[envVar])) {
          return fatalError(`Missing environment variable "${envVar}".`);
        }
      }
      return command.execute(projectDir, config, process.env, options);
    });
  }

  return resultPromise.catch(err => fatalError(err));
}

const helpInformation = program.Command.prototype.helpInformation;
program.Command.prototype.helpInformation = function() {
  return `
     _____ __
    / ___// /_____ ________  __
    \\__ \\/ __/ __ \`/ ___/ / / /
   ___/ / /_/ /_/ / /__/ /_/ /
  /____/\\__/\\__,_/\\___/\\__, /
                      /____/

${helpInformation.call(this)}
`;
}

program
.name("stacy")
.version(pkg.version)

program
.command("new <siteId>")
.description("Create new website project.")
.option(
  "--cf-space <spaceId>",
  "REQUIRED: Contentful space ID"
)
.option(
  "--cf-environment <environment>",
  "Contentful environment (default: \"master\")"
)
.option(
  "--cf-access-token <token>",
  "REQUIRED: Contentful Content Delivery API access token"
)
.option(
  "--cf-host <host>",
  "Contentful Content Delivery API host (default: \"cdn.contentful.com\")"
)
.action((siteId, options) => {
  options.siteId = siteId;
  options.stacyVersion = options.parent.version();
  if (common.isEmpty(options.cfSpace)) {
    console.error("error: missing option '--cf-space'");
    process.exitCode = 1;
  }
  else if (common.isEmpty(options.cfAccessToken)) {
    console.error("error: missing option '--cf-access-token'");
    process.exitCode = 1;
  }
  else {
    executeCommand("new", options);
  }
});

program
.command("generate")
.description("Generate complete website and save it in /build/site.")
.option(
  "-a --with-assets",
  "download assets and include them in the generated site"
)
.option(
  "-m --write-metadata",
  "save generated site metadata document"
)
.action(options => {
  executeCommand("generate", options);
});

program
.command("serve")
.description("Serve website locally in development mode.")
.option(
  "-p, --port <port>",
  "port, on which to listen for HTTP requests",
  v => parseInt(v),
  8080
)
.action(options => {
  executeCommand("serve", options);
});

program
.command("publish")
.description("Generate complete website, build publisher Lamdbda function" +
  " package and publish everything in the target AWS environment.")
.option(
  "--keep-publisher-enabled",
  "do not disable publish events in the target environment"
)
.option(
  "--no-prompt",
  "do not prompt user for operation confirmation"
)
.option(
  "--no-generate",
  "do not generate website, use what's already in /build"
)
.option(
  "--no-build-publisher",
  "do not build publisher Lambda function package, use what's already in /build"
)
.action(options => {
  executeCommand("publish", options);
});

program
.command("build-publisher")
.description("Build publisher Lambda function package and save it in /build.")
.action(options => {
  executeCommand("build-publisher", options);
});

program.on("command:*", () => {
  console.error(`Invalid command: ${program.args.join(' ')}` +
    "\nSee --help for a list of available commands.");
  process.exitCode = 1;
});

program.parse(process.argv);

if (program.args.length === 0) {
  program.outputHelp();
}
