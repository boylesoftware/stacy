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

const https = require("https");
const AWS = require("aws-sdk");
const contentful = require("contentful");
const mime = require("mime");

const stacy = require("./stacy-runtime.js");
const Handlebars = require("./handlebars-runtime.js");

const config = require("./stacy.json");
const templatesBagSrc = require("./templates.js");

const dynamodb = new AWS.DynamoDB();
const s3 = new AWS.S3();
const sns = new AWS.SNS();

function reportError(message, err) {

  console.error(message, err);

  const topicArn = process.env["ERRORS_TOPIC_ARN"];
  if (typeof topicArn === "string" && topicArn.length > 0) {
    return new Promise(resolve => {
      sns.publish({
        TopicArn: topicArn,
        Subject: `Stacy error at ${config.siteId}`,
        Message: `${message}\n\n${err.stack || err.message || err}`
      }, err => {
        if (err) {
          console.error("Unable to send error message to errors topic:", err);
        }
        resolve();
      });
    });
  }
}

const g_cfClients = {};

function getContentfulClient(sys) {

  const clientKey = `${sys.space.sys.id}/${sys.environment.sys.id}`;
  let client = g_cfClients[clientKey];
  if (!client) {
    client = contentful.createClient({
      space: sys.space.sys.id,
      accessToken: process.env["CF_ACCESS_TOKEN"],
      host: process.env["CF_HOST"],
      environment: sys.environment.sys.id,
      resolveLinks: false
    });
    g_cfClients[clientKey] = client;
  }
  return client;
}

let g_templatesBag;

function getTemplatesBag(templatesEngine) {

  if (g_templatesBag === undefined) {
    g_templatesBag = {};
    for (const ext of Object.keys(templatesBagSrc)) {
      const templates = {};
      g_templatesBag[ext] = templates;
      const templatesSrc = templatesBagSrc[ext];
      for (const entryType of Object.keys(templatesSrc)) {
        templates[entryType] =
          templatesEngine.template(templatesSrc[entryType]);
      }
    }
  }

  return g_templatesBag;
}

function getS3KeyPrefix(folder) {
  return (typeof folder === "string" && folder.length > 0 ? `${folder}/` : "");
}

function publishPage(page) {

  let chain = new Promise((resolve, reject) => {
    console.log(`publishing page #${page.pageEntryId} at ${page.publishPath}`);
    s3.upload({
      Bucket: process.env["TARGET_BUCKET"],
      Key: page.publishPath,
      ContentType: page.contentType,
      Body: page.content
    }, (err, data) => {
      if (err) {
        reject(err);
      }
      else {
        console.log(`published page at ${data.Location}`);
        resolve();
      }
    });
  });

  chain = chain.then(() => new Promise((resolve, reject) => {
    console.log("storing entries used by page in site metadata: " +
      `[${page.involvedEntryIds}]`);
    dynamodb.updateItem({
      TableName: process.env["SITE_META_TABLE"],
      Key: { "Id": { S: page.pageEntryId } },
      UpdateExpression: "SET " + [
        "UsedEntryIds = :UsedEntryIds",
        "PublishPath = :PublishPath"
      ].join(", "),
      ExpressionAttributeValues: {
        ":UsedEntryIds": { SS: page.involvedEntryIds },
        ":PublishPath": { S: page.publishPath }
      },
      ReturnValues: "ALL_OLD"
    }, (err, data) => {
      if (err) {
        reject(err);
      }
      else {
        const involvedEntryIdsSet = new Set(page.involvedEntryIds);
        const removedEntryIds = ((
          data.Attributes && data.Attributes.UsedEntryIds &&
          data.Attributes.UsedEntryIds.SS
        ) || []).filter(v => !involvedEntryIdsSet.has(v));
        let chain = Promise.resolve();
        for (const removedEntryId of removedEntryIds) {
          chain = chain.then(() => new Promise((resolve, reject) => {
            console.log(`removing entry #${removedEntryId} association` +
              " with the page from site metadata");
            dynamodb.updateItem({
              TableName: process.env["SITE_META_TABLE"],
              Key: { "Id": { S: removedEntryId } },
              UpdateExpression: "DELETE PageEntryIds :PageEntryIds",
              ExpressionAttributeValues: {
                ":PageEntryIds": { SS: [ page.pageEntryId ] }
              }
            }, err => {
              if (err) {
                reject(err);
              }
              else {
                resolve();
              }
            });

          }));
        }
        resolve(chain);
      }
    });
  }));

  for (const entryId of page.involvedEntryIds) {
    chain = chain.then(() => new Promise((resolve, reject) => {
      console.log(`storing entry #${entryId} association with` +
        " the page in site metadata");
      dynamodb.updateItem({
        TableName: process.env["SITE_META_TABLE"],
        Key: { "Id": { S: entryId } },
        UpdateExpression: "ADD PageEntryIds :PageEntryIds",
        ExpressionAttributeValues: {
          ":PageEntryIds": { SS: [ page.pageEntryId ] }
        }
      }, err => {
        if (err) {
          reject(err);
        }
        else {
          resolve();
        }
      });
    }));
  }

  return chain;
}

async function publishEntry(
  cfClient, templatesEngine, templatesBag, entryId, entryType
) {

  console.log(`publishing "${entryType}" entry #${entryId}`);

  let chain;
  if (config.pageContentTypes.includes(entryType)) {
    chain = Promise.resolve([entryId]);
  } else {
    chain = new Promise((resolve, reject) => {
      console.log(`looking up page entry id in site metadata`);
      dynamodb.getItem({
        TableName: process.env["SITE_META_TABLE"],
        Key: { "Id": { S: entryId } },
        ProjectionExpression: "PageEntryIds",
        ConsistentRead: true
      }, (err, data) => {
        if (err) {
          reject(err);
        }
        else {
          resolve((data.Item && data.Item.PageEntryIds.SS) || []);
        }
      });
    });
  }

  chain = chain.then(pageEntryIds => {
    if (pageEntryIds.length === 0) {
      console.log("no pages found for the entry, ignoring publish");
    }
    else {
      console.log(`fetching content for pages: [${pageEntryIds}]`);
      return stacy.fetchContentAndGeneratePages(
        pageEntryIds, config, cfClient, templatesEngine, templatesBag, {
          publishPage
        }
      );
    }
  });

  return chain.then(() => {
    console.log("entry publish completed");
  });
}

async function unpublishEntry(entryId, entryType) {

  console.log(`unpublishing "${entryType}" entry #${entryId}`);

  if (!config.pageContentTypes.includes(entryType)) {
    console.log("the entry is not a page, ignoring unpublish");
    return;
  }

  return new Promise((resolve, reject) => {
    console.log("removing page from site metadata");
    dynamodb.deleteItem({
      TableName: process.env["SITE_META_TABLE"],
      Key: { "Id": { S: entryId } },
      ReturnValues: "ALL_OLD"
    }, (err, data) => {
      if (err) {
        reject(err);
      }
      else {
        let chain = Promise.resolve();
        const usedEntryIds =
          (data.Attributes && data.Attributes.UsedEntryIds.SS) || [];
        for (const usedEntryId of usedEntryIds) {
          chain = chain.then(() => new Promise((resolve, reject) => {
            console.log(`removing entry #${usedEntryId} association` +
              " with the page from site metadata");
            dynamodb.updateItem({
              TableName: process.env["SITE_META_TABLE"],
              Key: { "Id": { S: usedEntryId } },
              UpdateExpression: "DELETE PageEntryIds :PageEntryIds",
              ExpressionAttributeValues: {
                ":PageEntryIds": { SS: [ entryId ] }
              }
            }, err => {
              if (err) {
                reject(err);
              }
              else {
                resolve();
              }
            });
          }));
        }
        resolve(chain.then(() => data.Attributes.PublishPath.S));
      }
    });
  })
  .then(publishPath => new Promise(resolve => {
    console.log(`deleting page from S3 at ${publishPath}`);
    s3.deleteObject({
      Bucket: process.env["TARGET_BUCKET"],
      Key: publishPath
    }, err => {
      resolve(
        err ?
          reportError(`Unable to delete ${publishPath} from S3:`, err) :
          undefined
      );
    });
  }))
  .then(() => {
    console.log("entry unpublish completed");
  });
}

async function publishAsset(assetId, fields) {

  console.log(`publishing asset #${assetId}`);

  const assetsS3Path =
    `${getS3KeyPrefix(process.env["TARGET_FOLDER"])}${config.assetsPath}`;

  let chain = Promise.resolve();
  const files = (fields.file.url ? [fields.file] : Object.values(fields.file));
  const fileNames = new Set();
  for (const file of files) {
    chain = chain.then(() => new Promise((resolve, reject) => {
      console.log(`downloading asset from https:${file.url}`);
      const fileName = file.url.substring(file.url.lastIndexOf("/") + 1);
      fileNames.add(fileName);
      https.get(`https:${file.url}`, res => {
        const statusCode = res.statusCode;
        if (statusCode !== 200) {
          res.resume();
          reject(new Error(
            `Failed to download asset with status code ${statusCode}.`));
        }
        else {
          s3.upload({
            Bucket: process.env["TARGET_BUCKET"],
            Key: `${assetsS3Path}/${fileName}`,
            ContentLength: res.headers["content-length"] ||
              (file.details && file.details.size),
            ContentType: res.headers["content-type"] || file.contentType ||
              mime.getType(file.url) || mime.getType("bin"),
            Body: res
          }, (err, data) => {
            if (err) {
              res.resume();
              reject(err);
            }
            else {
              console.log(`uploaded asset to ${data.Location}`);
              resolve();
            }
          });
        }
      })
      .on("error", err => {
        reject(err);
      });
    }));
  }

  chain = chain.then(() => new Promise((resolve, reject) => {
    const fileNamesList = Array.from(fileNames);
    console.log(`storing asset file names in site metadata: ` +
      `[${fileNamesList.join(",")}]`);
    dynamodb.updateItem({
      TableName: process.env["SITE_META_TABLE"],
      Key: { "Id": { S: assetId } },
      UpdateExpression: "SET FileNames = :FileNames",
      ExpressionAttributeValues: {
        ":FileNames": { SS: fileNamesList }
      }
    }, err => {
      if (err) {
        reject(err);
      }
      else {
        resolve();
      }
    });
  }));

  return chain.then(() => {
    console.log("asset publish completed");
  });
}

async function unpublishAsset(assetId) {

  console.log(`unpublishing asset #${assetId}`);

  const assetsS3Path =
    `${getS3KeyPrefix(process.env["TARGET_FOLDER"])}${config.assetsPath}`;

  return new Promise((resolve, reject) => {
    console.log("removing asset from site metadata");
    dynamodb.deleteItem({
      TableName: process.env["SITE_META_TABLE"],
      Key: { "Id": { S: assetId } },
      ReturnValues: "ALL_OLD"
    }, (err, data) => {
      if (err) {
        reject(err);
      }
      else {
        const fileNames =
          (data.Attributes && data.Attributes.FileNames.SS) || [];
        if (fileNames.length === 0) {
          console.log("no files were associated with asset in site metadata");
          resolve();
        }
        else {
          console.log(`deleting asset files from S3: [${fileNames.join(",")}]`);
          let chain = Promise.resolve();
          for (const fileName of fileNames) {
            chain = chain.then(() => new Promise(resolve => {
              console.log(`deleting ${assetsS3Path}/${fileName} from S3`);
              s3.deleteObject({
                Bucket: process.env["TARGET_BUCKET"],
                Key: `${assetsS3Path}/${fileName}`
              }, err => {
                resolve(
                  err ?
                    reportError(`unable to delete ${assetsS3Path}/${fileName}` +
                      " from S3:", err) :
                    undefined
                );
              });
            }));
          }
          resolve(chain);
        }
      }
    });
  })
  .then(() => {
    console.log("asset unpublish completed");
  });
}

exports.handler = function(event) {

  let resultPromise = Promise.resolve();
  for (const rec of event.Records) {
    try {
      const body = JSON.parse(rec.body);
      let unknownEvent = false;
      switch (body.event) {
        case "ContentManagement.Entry.publish":
          resultPromise = resultPromise.then(() => publishEntry(
            getContentfulClient(body.payload.sys),
            Handlebars,
            getTemplatesBag(Handlebars),
            body.payload.sys.id,
            body.payload.sys.contentType.sys.id
          ));
          break;
        case "ContentManagement.Entry.unpublish":
          resultPromise = resultPromise.then(() => unpublishEntry(
            body.payload.sys.id,
            body.payload.sys.contentType.sys.id
          ));
          break;
        case "ContentManagement.Asset.publish":
          resultPromise = resultPromise.then(() => publishAsset(
            body.payload.sys.id,
            body.payload.fields
          ));
          break;
        case "ContentManagement.Asset.unpublish":
          resultPromise = resultPromise.then(() => unpublishAsset(
            body.payload.sys.id
          ));
          break;
        default:
          console.log(`unknown publish event "${body.event}"`);
          unknownEvent = true;
      }
      if (!unknownEvent) {
        resultPromise = resultPromise.catch(
          err => reportError(`Error processing publish event:`, err)
        );
      }
    } catch (err) {
      resultPromise = resultPromise.catch(
        err => reportError(`Error processing publish event:`, err)
      );
    }
  }

  return resultPromise;
};
