"use strict";
// TODO: add license
console.log("Loading function");

//const templates = require("./templates.json");

exports.handler = async (event) => {
  //console.log("Received event:", JSON.stringify(event, null, 2));
  for (const { messageId, body } of event.Records) {
    console.log("SQS message %s: %j", messageId, body);
  }
  return `Successfully processed ${event.Records.length} messages.`;
};
