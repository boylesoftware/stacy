# Stacy

Stacy is a website generator that combines content from [Contentful CMS](https://www.contentful.com/) with [Handlebars](https://handlebarsjs.com/) templates to create the website pages.

Stacy matches Contentful's entry content types with Handlebars templates in your website project in a one-to-one relationship&mdash;there is a template for every entry type defined in your _Content model_. There are two types of entries from Stacy's point of view: _page entries_ and _module entries_. A page entry combined with its template produces a single website page at a unique URL. Module entries can be included in pages and other modules using Contentful's _Reference_ fields to create reusable pieces of content or simply to provide content and templates structure by breaking it up into smaller pieces.

What makes Stacy different from many existing static website generators is that it supports automatic publishing of the website to an S3 bucket in [Amazon Cloud](https://aws.amazon.com/), from where it can be served on the Internet. Stacy deploys special infrastructure in Amazon Cloud which can be connected to Contentful via its [Webhooks](https://www.contentful.com/developers/docs/concepts/webhooks/) functionality. When content is updated in your Contentful space, your website's infrastructure deployed by Stacy in Amazon Cloud gets notified and automatically regenerates and republishes only those pages of your website that are affected by the update. No manual website regeneration and redeployment is required.

When using Stacy, your website is an [NPM](https://www.npmjs.com/) project usually checked in a git repository for version control. The project includes your Handlebars templates and static content (such as CSS stylesheets, images used in the website design, fonts, etc.), while the website content lives in the Contentful space. From the website project the website developers use Stacy command line tool to develop, publish and republish the site. Once the website is published in Amazon Cloud, the content authors work only with Contentful UI.

TODO: Link to the detailed sample website development and deployment walkthrough.

## Getting Started

First, you need a Contentful space for your website's content. Once you have that, you can create a new project for your website.

Make sure that you have [Node.js](https://nodejs.org/en/) version 10.16.3 or newer installed together with npm. If you are going to be publishing the website in Amazon Cloud, you will also need [AWS CLI](https://aws.amazon.com/cli/) installed.

Start with installing Stacy globally:

```
npm install -g stacy
```

In your Contentful space, go to _Space settings&rarr;API keys_ and add an API key in _Content delivery/preview tokens_. Note _Space ID_ and _Content Delivery API access token_ values that you will use to connect your Stacy environment to your Contentful space.

Now, you can generate initial project for your website:

```
stacy new --cf-space <your space ID> --cf-access-token <your access token> mywebsite
```

This will create a new project directory named "mywebsite" in the current directory. The "mywebsite" value is known as the _site ID_. Use a different value that identifies your website. The value should be URL-fiendly (small letters, digits and dashes).

In your project directory, put static content under `/static` (this gets copied over to your website as-is) and put your entry templates under `/templates`. The name of the template file (sans the extention) must exactly match the corresponding entry content type in your Contentful _Content model_. Under `/templates`, the template files can be organized in subfolders. However, the file names must be unique across all subfolders because they are used to uniquely match templates to entry content types (subfolders in `/templates` play no role).

Note: Normally, a template, combined with an entry's content, produces HTML. If you need to produce some other type of content, you can add an extension to the template name. For example, `page.hbs` produces HTML. To produce plain text use `page.txt.hbs`. This also means that `page.hbs` and `page.html.hbs` are the same.

You can now run your website locally for development purposes:

```
stacy serve
```

You can see your website at `http://localhost:8080/`. After you edit any template, static content or content in Contentful, just reload the page.

To stop Stacy local webserver use `Ctrl+C`.

Run `stacy --help` to see other available commands.

The content of your project directory you can check in to a git repository such as [GitHub](https://github.com/) or [Bitbucket](https://bitbucket.org/product/).

## Templates

Inside you templates all entry fields are available by the _Field ID_ as defined in your _Content model_. You can reference them directly in your template. For example:

```handlebars
<h3>{{caption}}</h3>
```

This will output the value of the entry's `caption` field. Note, that it's _Field ID_ which is used here and **not** the field _Name_.

Stacy adds a few special [helpers](https://handlebarsjs.com/#helpers) that you can use in your templates:

* `module <reference field>` - Include module entry referenced by the Reference type field. For example, given that you have a field with ID `paragraphs` and it is a list of references:

  ```handlebars
  {{#each paragraphs}}{{{module this}}}{{/each}}
  ```

* `asset <asset field>` - Include the referred asset, such an image. For example:

  ```handlebars
  {{asset picture}}
  ```

  Currently, only image assets are supported, for which an HTML `<img>` tag is rendered.

* `assetSrc <asset field>` - Get URL of the asset. For example:

  ```handlebars
  <img src="{{assetSrc picture}}">
  ```

* `assetTitle <asset field>` - Get title of the asset. For example:

  ```handlebars
  <img src="{{assetSrc picture}}" alt="{{assetTitle picture}}">
  ```

* `markdown <long text field>` - Render Markdown long text field. For example:

  ```handlebars
  {{{markdown description}}}
  ```

  Note the tripple-braces needed here because the helper generates HTML which needs not to be escaped.

* `richText <rich text field>` - Render rich text field. For example:

  ```handlebars
  {{{richText content}}}
  ```

  As with `markdown`, note the triple-braces.

* `json <field>` - Output internal Contentful JSON representation of the field. For example:

  ```handlebars
  <pre>{{json myField}}</pre>
  ```

  This helper may be useful for diagnosing problems.

## Content Model

As mentioned above, there is a one-to-one relationship between content types you define in your Contentful space's _Content model_ and templates.

Note: Strictly speaking, you can have more than one template for a given content type to allow generation of different types of files for the same content entry. For example, for content type ID `module` you could have templates `module.html.hbs` and `module.xml.hbs`. First tempplate will produce an HTML file for the entry and the second will produce an XML file.

When you define a content type, note the _Api Identifier_ (also known as _content type ID_). The template file for the content type will have to have the same name (plus the extention).

There is one requirement for content types for page entries (as opposed to module entries): a page content type must define a required _slug_ field. The value in the field will be determining the name of the generated file when the content entry is combined with the corresponding template. For example, if slug value for a page entry is "index", the generated page will be "/index.html". If the slug is "more/terms", the page will be "/more/terms.html". And so on.

By default, the field ID for the slug field must be `slug`. The ID can be overridden in the project's `stacy.json` file. Besides making the slug field required in the content type definition, it is also recommended to associate a custom match pattern validator with it to ensure the field value's specific format. The regular expression for the validator can be `^\w[\w-]*(/\w[\w-]*)*$`.

## Publishing in Amazon Cloud

When you are ready to deploy your website in AWS, you first need to setup Stacy infrastructure under your AWS account. You must perform several steps before you can do it:

1. Create the target [S3](https://aws.amazon.com/s3/) bucket. This is where your website will be published and from where it will be served (probably via [CloudFront](https://aws.amazon.com/cloudfront/)). Alternatively, you can use a bucket that you already have (Stacy also supports publishing in a subfolder in the target bucket).

2. If you don't have it yet, create an S3 bucket that Stacy will use to upload the publisher [Lambda](https://aws.amazon.com/lambda/) function package. The publisher Lambda function is the piece that responds to Contentful _publish_ and _unpublish_ events and updates the relevant pages and assets in the target S3 bucket.

3. Build the publisher package:

   ```
   stacy build-publisher
   ```

   This will create the publisher Lambda function package in your project under `/build/stacy-mywebsite-publisher.zip`. Upload this file to your Lambda functions S3 bucket.

Stacy's `stacy new` command has generated a [CloudFormation](https://aws.amazon.com/cloudformation/) template for the AWS environment and saved it in your project under `/misc/cfn-template.json`. You can review and customize it if necessary. Otherwise, go ahead and create Stacy stack for your website under your AWS account.

Once the CloudFormation stack is created, you need to adjust the target S3 bucket's policy to allow Stacy publisher publish generated website content in it. The bucket's policy can include something like the following:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "AWS": "<Stacy publisher role ARN>"
            },
            "Action": [
                "s3:PutObject",
                "s3:DeleteObject"
            ],
            "Resource": "arn:aws:s3:::<bucket name>/*"
        }
    ]
}
```

In the above policy replace Stacy publisher role ARN with the value that you can find in your CloudFormation stack's `PublisherRoleArn` output parameter, and the bucket name with the target website bucket name (the bucket, to which the policy is applied).

Now you have to prepare your development environment for publishing. Open and edit `.env` file in your website project. In it, set all `AWS_*` variables to the correct values. Note, that you can find the value for `AWS_PUBLISH_EVENT_SOURCE_MAPPING` variable in the CloudFormation stack's `PublishEventSourceMappingId` output parameter.

Once your `.env` file is correctly setup, you can publish your website using:

```
stacy publish
```

One last setup step is to configure a webhook in your Contentful space to call Stacy publisher on _publish_ and _unpublish_ events. In your AWS account, in [API Gateway](https://aws.amazon.com/api-gateway/) service find the API created for you by Stacy. There is only one method `POST /publish` in the API's `prod` stage. Note its _Invoke URL_.

Also, go to the _API Keys_ section and note the value of the API key created for Stacy.

In your Contentful space go to _Space settings&rarr;Webhooks_ and add a webhook. Put the API Gatwey's invoke URL in the URL field (leave the method `POST`). Then pick _Select specific triggering events_ option in the _Triggers_ section. Check _Publish_ and _Unpublish_ checkboxes in _Entry_ and _Asset_ rows (4 checkboxes checked altogether).

In the _Headers_ section click _Add secret header_. Put "X-API-Key" in the _Key_ field and in the _Value_ field put the API key from the API Gateway.

Once you save this webhook, publishing and unpulishing entries and assets in Contentful will trigger the publisher in the AWS setup and you are all set!
