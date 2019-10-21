#!/usr/bin/env node

"use strict";

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

  // TODO: recognize Contentful error and display it in a briefer way

  if (typeof error === "string") {
    console.error(`ERROR: ${error}`);
  }
  else {
    console.error("ERROR:", error);
  }

  process.exitCode = 1;
}

function executeCommand(commandName, cmd) {

  const command = require(`./commands/${commandName}`);
  findUp("stacy.json")
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
        return fatalError(`Missing required environment variable "${envVar}".`);
      }
    }
    return command.execute(projectDir, config, process.env, cmd);
  })
  .catch(err => fatalError(err));
}

program.name("stacy").version(pkg.version);

program
.command("generate")
.description("Generate complete website and save it in /dist/site.")
.option(
  "-a --with-assets",
  "download assets and include them in the generated site"
)
.option(
  "-m --write-metadata",
  "save generated site metadata document"
)
.action(cmd => {
  executeCommand("generate", cmd);
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
.action(cmd => {
  executeCommand("serve", cmd);
});

program
.command("build-publisher")
.description("Build publisher Lambda function package and save it in /dist.")
.action(cmd => {
  executeCommand("build-publisher", cmd);
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
  "do not generate website, use what's already in /dist"
)
.option(
  "--no-build-publisher",
  "do not build publisher Lambda function package, use what's already in /dist"
)
.action(cmd => {
  executeCommand("publish", cmd);
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
