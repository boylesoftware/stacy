"use strict";

const child_process = require("child_process");
const readline = require("readline");
const fse = require("fs-extra");

const common = require("../common.js");
const generateCommand = require("./generate.js");
const buildPublisherCommand = require("./build-publisher.js");

const CANCELLED = Symbol("CANCELLED");

exports.REQUIRED_ENV = [
  "CF_SPACE",
  "CF_ACCESS_TOKEN",
  "AWS_TARGET_BUCKET",
  "AWS_LAMBDA_FUNCTIONS_BUCKET",
  "AWS_PUBLISH_EVENT_SOURCE_MAPPING"
];

function addAWSProfile(env, args) {
  const profile = env["AWS_PROFILE"];
  return (common.isEmpty(profile) ? args : ["--profile", profile].concat(args));
}

function getPublishEventSourceState(env) {
  return new Promise((resolve, reject) => {
    const responseChunks = [];
    child_process.spawn(
      "aws", addAWSProfile(env, [
        "lambda", "get-event-source-mapping",
        "--uuid", env["AWS_PUBLISH_EVENT_SOURCE_MAPPING"]
      ]), {
        stdio: ["inherit", "pipe", "inherit"]
      }
    )
    .on("error", err => {
      reject(err);
    })
    .on("exit", exitCode => {
      if (exitCode === 0) {
        try {
          const response = JSON.parse(
            Buffer.concat(responseChunks).toString("utf8")
          );
          resolve(response.State);
        } catch (err) {
          reject(err);
        }
      }
      else {
        reject(`AWS operation finished with exit code ${exitCode}.`);
      }
    })
    .stdout.on("data", data => {
      responseChunks.push(data);
    });
  });
}

function enablePublishEventSource(env, enable) {
  return new Promise((resolve, reject) => {
    console.log(`${enable ? "en" : "dis"}abling publish events...`);
    const responseChunks = [];
    child_process.spawn(
      "aws", addAWSProfile(env, [
        "lambda", "update-event-source-mapping",
        "--uuid", env["AWS_PUBLISH_EVENT_SOURCE_MAPPING"],
        (enable ? "--enabled" : "--no-enabled")
      ]), {
        stdio: ["inherit", "pipe", "inherit"]
      }
    )
    .on("error", err => {
      reject(err);
    })
    .on("exit", exitCode => {
      if (exitCode === 0) {
        try {
          const response = JSON.parse(
            Buffer.concat(responseChunks).toString("utf8")
          );
          resolve(response.State);
        } catch (err) {
          reject(err);
        }
      }
      else {
        reject(`AWS operation finished with exit code ${exitCode}.`);
      }
    })
    .stdout.on("data", data => {
      responseChunks.push(data);
    });
  })
  .then(state => new Promise(resolve => {
    (function waitForTargetState(lastState) {
      if (lastState === (enable ? "Enabled" : "Disabled")) {
        resolve();
      }
      else {
        console.log("waiting for publish events to become " +
          `${enable ? "en" : "dis"}abled...`);
        setTimeout(() => {
          getPublishEventSourceState(env)
          .then(newState => waitForTargetState(newState));
        }, 8000);
      }
    })(state);
  }));
}

function syncTargetBucket(projectDir, env) {
  return new Promise((resolve, reject) => {
    console.log("synchronizing target S3 bucket with the generated site...");
    const targetBucket = env["AWS_TARGET_BUCKET"];
    const targetFolder = env["AWS_TARGET_FOLDER"];
    const targetKeyPrefix = (
      common.isEmpty(targetFolder) ? "" : `${targetFolder}/`
    );
    child_process.spawn(
      "aws", addAWSProfile(env, [
        "s3", "sync",
        "--delete",
        `${projectDir}/dist/site/`, `s3://${targetBucket}/${targetKeyPrefix}`
      ]), {
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
        reject(`AWS operation finished with exit code ${exitCode}.`);
      }
    });
  });
}

function updatePublisherLambdaFunction(projectDir, config, env) {
  return new Promise((resolve, reject) => {
    console.log("uploading publisher Lambda function to S3...");
    child_process.spawn(
      "aws", addAWSProfile(env, [
        "s3", "cp",
        `${projectDir}/dist/stacy-${config.siteId}-publisher.zip`,
        `s3://${env["AWS_LAMBDA_FUNCTIONS_BUCKET"]}/`
      ]), {
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
        reject(`AWS operation finished with exit code ${exitCode}.`);
      }
    });
  })
  .then(() => new Promise((resolve, reject) => {
    console.log("updating publisher Lambda function code...");
    child_process.spawn(
      "aws", addAWSProfile(env, [
        "lambda", "update-function-code",
        "--function-name", `stacy-${config.siteId}-publisher`,
        "--s3-bucket", env["AWS_LAMBDA_FUNCTIONS_BUCKET"],
        "--s3-key", `stacy-${config.siteId}-publisher.zip`
      ]), {
        stdio: ["inherit", "ignore", "inherit"]
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
        reject(`AWS operation finished with exit code ${exitCode}.`);
      }
    });
  }));
}

function scanSiteMatdataTable(config, env) {
  return new Promise((resolve, reject) => {
    console.log("loading existing site metadata...");
    const responseChunks = [];
    child_process.spawn(
      "aws", addAWSProfile(env, [
        "dynamodb", "scan",
        "--table-name", `stacy-${config.siteId}-site-meta`
      ]), {
        stdio: ["inherit", "pipe", "inherit"]
      }
    )
    .on("error", err => {
      reject(err);
    })
    .on("exit", exitCode => {
      if (exitCode === 0) {
        try {
          const response = JSON.parse(
            Buffer.concat(responseChunks).toString("utf8")
          );
          resolve(response);
        } catch (err) {
          reject(err);
        }
      }
      else {
        reject(`AWS operation finished with exit code ${exitCode}.`);
      }
    })
    .stdout.on("data", data => {
      responseChunks.push(data);
    });
  });
}

function batchUpdateSiteMetadataTable(config, env, batch) {
  return new Promise((resolve, reject) => {
    console.log("sending batch to update site metadata...");
    const tableName = `stacy-${config.siteId}-site-meta`;
    const responseChunks = [];
    child_process.spawn(
      "aws", addAWSProfile(env, [
        "dynamodb", "batch-write-item",
        "--request-items", JSON.stringify({
          [tableName]: batch
        })
      ]), {
        stdio: ["inherit", "pipe", "inherit"]
      }
    )
    .on("error", err => {
      reject(err);
    })
    .on("exit", exitCode => {
      if (exitCode === 0) {
        try {
          const response = JSON.parse(
            Buffer.concat(responseChunks).toString("utf8")
          );
          resolve(response.UnprocessedItems[tableName] || []);
        } catch (err) {
          reject(err);
        }
      }
      else {
        reject(`AWS operation finished with exit code ${exitCode}.`);
      }
    })
    .stdout.on("data", data => {
      responseChunks.push(data);
    });
  });
}

function executeUpdateSiteMetadataTableBatches(config, env, actions) {

  const actionBatches = [];
  let actionBatch = [];
  actionBatches.push(actionBatch);
  for (const action of actions) {
    if (actionBatch.length === 25) {
      actionBatch = [];
      actionBatches.push(actionBatch);
    }
    actionBatch.push(action);
  }
  let chain = Promise.resolve([]);
  for (const batch of actionBatches) {
    chain = chain.then(
      curUA => batchUpdateSiteMetadataTable(config, env, batch).then(
        newUA => curUA.concat(newUA)
      )
    );
  }
  return chain;
}

function equalItems(item1, item2) {

  const item1Keys = Object.keys(item1);
  if (item1Keys.length !== Object.keys(item2).length) {
    return false;
  }
  for (const key of item1Keys) {
    const val1 = item1[key];
    const val2 = item2[key];
    if (val2 === undefined) {
      return false;
    }
    if (Array.isArray(val1)) {
      if (!Array.isArray(val2)) {
        return false;
      }
      if (val1.length !== val2.length) {
        return false;
      }
      val1.sort();
      val2.sort();
      for (let i = 0, len = val1.length; i < len; i++) {
        if (val1[i] !== val2[i]) {
          return false;
        }
      }
      return true;
    }
    else if (typeof val1 === "object") {
      if (typeof val2 !== "object") {
        return false;
      }
      return equalItems(val1, val2);
    }
    else {
      return (val1 === val2);
    }
  }
}

exports.execute = function(projectDir, config, env, cmd) {

  const targetBucket = env["AWS_TARGET_BUCKET"];
  const targetFolder = env["AWS_TARGET_FOLDER"];
  const targetKeyPrefix = (
    common.isEmpty(targetFolder) ? "" : `${targetFolder}/`
  );

  let publishEventsDisabled = false;

  // confirm operation
  return (
    cmd.prompt ?
      new Promise((resolve, reject) => {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        rl.question(`
Publishing site at s3://${targetBucket}/${targetKeyPrefix}

NOTE: This will completely overwrite the site in the target environment.

Proceed? (yes/no) `, answer => {
          rl.close();
          if (answer !== "yes") {
            reject(CANCELLED);
          }
          else {
            resolve();
          }
        });
      }) :
      undefined
  )

  // disable publish events
  .then(() => (
    cmd.keepPublisherEnabled ?
      Promise.resolve() :
      enablePublishEventSource(env, false).then(() => {
        publishEventsDisabled = true;
      })
  ))

  // generate the site
  .then(() => {
    if (cmd.generate) {
      console.log("generating the site...");
      return generateCommand.execute(projectDir, config, env, {
        withAssets: true,
        writeMetadata: true
      });
    }
    else {
      console.log("skipping site generation");
    }
  })

  // build the publisher package
  .then(() => {
    if (cmd.buildPublisher) {
      console.log("building publisher package...");
      return buildPublisherCommand.execute(projectDir, config);
    }
    else {
      console.log("skipping publisher package build");
    }
  })

  // sync site content with the target S3 bucket
  .then(() => syncTargetBucket(projectDir, env))

  // update publisher Lambda function
  .then(() => updatePublisherLambdaFunction(projectDir, config, env))

  // update site metadata DynamoDB table
  .then(() => Promise.all([
    scanSiteMatdataTable(config, env),
    fse.readJson(`${projectDir}/dist/site-metadata.json`)
  ]))
  .then(([oldSiteMetadata, newSiteMetadata]) => {
    const oldSiteMetadataMap = {};
    for (const item of oldSiteMetadata.Items) {
      oldSiteMetadataMap[item.Id.S] = item;
    }
    const actions = [];
    for (const newItem of newSiteMetadata.Items) {
      const itemId = newItem.Id.S;
      const oldItem = oldSiteMetadataMap[itemId];
      delete oldSiteMetadataMap[itemId];
      if (!oldItem || !equalItems(oldItem, newItem)) {
        actions.push({
          PutRequest: {
            Item: newItem
          }
        });
      }
    }
    for (const oldItem of Object.values(oldSiteMetadataMap)) {
      actions.push({
        DeleteRequest: {
          Key: {
            Id: oldItem.Id
          }
        }
      });
    }
    if (actions.length === 0) {
      console.log("no updates needed for the site metadata");
    }
    else {
      return executeUpdateSiteMetadataTableBatches(config, env, actions)
      .then(unprocessed => {
        if (unprocessed.length > 0) {
          console.log("not all updates were successful" +
            ", will retry in 5 seconds...");
          return new Promise(resolve => {
            setTimeout(() => resolve(
              executeUpdateSiteMetadataTableBatches(config, env, unprocessed)
            ), 5000);
          });
        }
      })
      .then(unprocessed => {
        if (unprocessed && unprocessed.length > 0) {
          return Promise.reject(new Error(
            "Unable to update site metadata table. Unprocessed actions are:\n" +
            JSON.stringify(unprocessed, null, "  ")
          ));
        }
      });
    }
  })

  // re-enable publish events if were disabled
  .then(
    () => (
      publishEventsDisabled ?
        enablePublishEventSource(env, true) :
        undefined
    ),
    err => (
      publishEventsDisabled ?
        enablePublishEventSource(env, true).then(() => Promise.reject(err)) :
        Promise.reject(err)
    )
  )

  // done
  .then(() => {
    console.log("publish comleted");
  })
  .catch(err => {
    if (err === CANCELLED) {
      console.log("publish cancelled");
    }
    else {
      return Promise.reject(err);
    }
  });
};
