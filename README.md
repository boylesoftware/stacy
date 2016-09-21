# Stacy

Stacy allows creating websites that are served from [Amazon S3](https://aws.amazon.com/s3/) cloud service as if they are static websites, while having the site content managed in [Contentful CMS](https://www.contentful.com/). The authors edit the content in the CMS and their edits are automatically published to the statically hosted website without any participation from the site developers. Once the system is setup, for regular content changes there is no need to run any site generators or manually upload any content to the S3.

![Diagram](https://raw.githubusercontent.com/boylesoftware/stacy-docs/master/img/diagram.png)

Stacy exposes an endpoint via [Amazon API Gateway](https://aws.amazon.com/api-gateway/) service, which is automatically called by a Contentful's webhook for every Entry and Asset *publish* and *unpublish* event. The endpoint then places the events into an [Amazon Kinesis](https://aws.amazon.com/kinesis/) stream, from which they are picked up by an [AWS Lambda](https://aws.amazon.com/lambda/) function. When the Lambda function receives a *publish* event for an asset (such as an image file), the asset file is uploaded into the website's bucket in S3. On an *unpublish* event the asset is removed from S3. When there is a *publish* for an entry, the corresponding HTML page is compiled using [Handlebars](http://handlebarsjs.com) templates (pre-compiled and packaged together with the Lambda function) and uploaded into the website's bucket. Respectively, when the page is *unublished*, the HTML file is removed from the bucket.

## Usage

The following usage information is for those who are familiar with the utilized AWS services and Contentful CMS. For a detailed website project setup walkthrough see the [Tutorial](https://github.com/boylesoftware/stacy-docs/blob/master/TUTORIAL.md).

### Lambda Function

To use Stacy in the Lambda function that is triggered by the Kinesis stream, the following Node.js code can be used:

```javascript
const Stacy = require('stacy');

exports.handler = Stacy.createHandler({
	siteConfigsS3Bucket: 'mysite-stacy',
	templates: require('./templates')
});
```

The Stacy module is published in NPM. The options object passed to the `Stacy.createHandler` function uses the following required properties:

* `siteConfigsS3Bucket` - Name of the Amazon S3 bucket that contains site configuration files. A single Stacy Lambda function can handle multiple sites. When the API Gateway places an event into the Kinesis stream, the identifier of the site, for which the event has occured, is included in the event record. Using the site identifier, Stacy load the site configuration file from the specified bucket. The site configuration file name is formed using the pattern `<site>-config.json` (for example, if the site id is "mysite", then its configuration file is `mysite-config.json`). See below for what goes into the site configuration file. The IAM role used by the Lambda function must have read access to the bucket.

* `templates` - Pre-compiled Handlebars templates for every site handled by the handler. The first level of keys in the provided object is the site ids. The second level of keys is the template names, which are the Contentful content type ids. The values are corresponding template specifications created by `Handlebars.precompile()` method.

The IAM role associated with the Lambda function must be allowed to read from the Kinesis stream, that is it must have the following permissions for it at a minimum: `kinesis:GetRecords`, `kinesis:GetShardIterator` and `kinesis:DescribeStream`.

### The Site Configuration File

The site configuration JSON file stored in S3 includes the following properties:

* `contentfulSpaceId` *(required)* - Id of the Contentful space with the site's content.

* `contentfulAPIKey` *(required)* - Contentful API key. Stacy uses it to make calls to the Contentful API.

* `contentMetaS3Bucket` *(required)* - Name of the S3 bucket used by Stacy to store a JSON file containing the site content meta-data. The file is maintained by Stacy automatically and describes the relationships between different content entries, maps asset ids to the file names, etc. The default name of the file follows pattern `<site>-content-meta.json` and can be overridden by the `contentMetaS3Key` optional site configuration property. The IAM role used to run the Lambda function must have read/write access to the bucket (at a minimum `s3:ListBucket`, `s3:GetObject`, `s3:GetObjectVersion` and `s3:PutObject`).

* `contentMetaS3Key` *(optional)* - Name of the site content meta-data JSON file.

* `contentS3Bucket` *(required)* - Name of the S3 bucket, from which the website is served. This is where the Lambda function publishes the compiled pages and assets. The bucket must have static website hosting enabled and the Stacy IAM role must have write permissions for it (at a minimum `s3:PutObject` and `s3:DeleteObject`).

* `assetsFolder` *(optional)* - Name of the folder under the `contentS3Bucket` where the assets are published. All Contentful assets are published in this single folder using their corresponding file names. The default value is "assets".

* `maxDepth` *(optional)* - Maximum number of nested references in the website's Contentful content. The default is 3 (meaning a top page can include another entry, which in turn can include one more).

* `pageContentTypes` *(optional)* - An array with Contentful content type ids that are top pages. Entries of other content types can be modules included in the pages or other modules, but only entries with the listed content types generate HTML files (that is pages). The default is an array with a single content type id "page".

* `pageSlugFieldName` *(optional)* - Name of the page content type field that contains the page slug. The page slug is the published page HTML file name without the ".html" suffix (for example "index", "products", "about", etc.).

### The Templates

The names of the pre-compiled templates must match the corresponding Contentful content type ids. The context object in the template is the Contentful entry fields, so the field values can be used directly with the Handlebars expressions syntax. In addition to the standard Handlebars syntax, Stacy provides the following helpers:

* `module <reference field name>` - Include the referred entry. For example:

  ```handlebars
  {{#each paragraphs}}{{{module this}}}{{/each}}
  ```

  Note the tripple-braces to allow the HTML.

* `assetSrc <asset field name>` - Get URL of the asset referred by the specified field. For example:

  ```handlebars
  <img src="{{assetSrc picture}}"/>
  ```

* `markdown <long text field name>` - Render Markdown long text field. For example:

  ```handlebars
  {{{markdown description}}}
  ```

  Also note the tripple-braces.

### Kinesis Stream Records

The Kinesis stream records consumed by Stacy Lambda function must have the following properties:

* `site` - The site id.

* `topic` - The Contentful event topic, which must be one of the following values: "ContentManagement.Entry.publish", "ContentManagement.Entry.unpublish", "ContentManagement.Asset.publish" or "ContentManagement.Asset.unpublish". The value comes from the `X-Contentful-Topic` header of the HTTP POST request submitted by the Contentful webhook.

* `payload` - The Contentful event payload, which is the body of the HTTP POST request submitted by the Contentful webhook.

Given the endpoint set up in Amazon API Gateway under `/sites/{site}/content-events` with AWS Service integration request type, the following body mapping template can be associated with the `application/vnd.contentful.management.v1+json` request content type:

```
#set($rec = "{
    ""site"": ""$input.params('site')"",
    ""topic"": ""$input.params('X-Contentful-Topic')"",
    ""payload"": $input.json('$')
}")
{
    "StreamName": "$stageVariables.streamName",
    "PartitionKey": "$input.params('site')",
    "Data": "$util.base64Encode($rec)"
}
```

Note, that the target Kinesis stream name comes from a stage variable named `streamName`.
