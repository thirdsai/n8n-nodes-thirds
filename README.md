# thirds.ai node for n8n

Send out branded PDFs and images straight from your n8n workflows. You save a design once in [thirds.ai](https://thirds.ai), such as an invoice, a client report, or a social post, with your logo, colours, and fonts. Then this node fills it with the data from each workflow run and hands you the finished file.

A new order can become an invoice PDF, and a new row in a sheet can become a social image. Each file comes back as n8n binary data, so the next step can email it, upload it, or post it.

## Install

You need n8n 1.0 or newer.

### In the n8n app

1. Open **Settings**, then **Community Nodes**.
2. Click **Install**.
3. Type `@thirds-ai/n8n-nodes-thirds` and click **Install**.

### With npm

For a self-hosted n8n, run this in your n8n folder, which is usually `~/.n8n/nodes`:

```sh
npm install @thirds-ai/n8n-nodes-thirds
```

Then restart n8n. n8n's guide to [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation-and-management/) has more ways to install.

## Connect your account

1. Sign in to [thirds.ai](https://thirds.ai) and open **API keys** in your account settings.
2. Make a new key and copy it. You only see the whole key once.
3. In n8n, add a **thirds.ai API** credential and paste the key.
4. Click **Save**. n8n checks the key right away and spends no credits.

Give each workflow tool its own key, and keep the key out of workflow notes and shared data. The [API guide](https://thirds.ai/docs/api#authentication) explains keys in more detail.

## Make a PDF

Pick a template and fill in its data. The node makes the PDF, waits for it, and puts it in the `data` binary field.

1. Add the **thirds.ai** node and choose **Make a PDF**.
2. Choose your template from the list. You can also paste its ID, which starts with `tpl_`.
3. Under **Data**, choose **Fill In Each Field**. The node shows every field your template has, such as the client name, the invoice number, and the total. Drag values in from earlier steps.
4. Run the step.

If your template doesn't list its fields, choose **Use JSON** and type the values, like this:

```json
{
  "client_name": "Harbor Street Bakery",
  "invoice_number": "INV-1042",
  "total": 480
}
```

## Make an image

**Make an image** works the same way and gives you a PNG, JPEG, or WebP. The picture is the size of your design, so a square post stays square. To pick another size, add **Width (Pixels)** and **Height (Pixels)** under **Options**.

## Options

| Option | What it does |
| --- | --- |
| Brand Kit ID | Uses the logo, colours, and fonts from another brand kit. |
| File Name | Names the file you download. |
| Output Field | Names the binary field that holds your file. The default is `data`. |
| Reference | Keeps your own note, such as an order number, with the file. |
| Retry Key | Sets your own retry key. Leave it empty and the node makes one. |
| Template Version | Uses one saved version. The default is the newest one. |
| Wait Up To (Seconds) | Sets how long the step waits for your file. The default is 120. |
| Width, Height, Quality, See-Through Background | Image settings for **Make an image**. |

## Retries never pay twice

Each file you ask for gets its own retry key. When n8n retries a step, the node sends the same key again and gets back the file it already made, so you pay once. If you set **Retry Key** yourself, use a new key for each new file, such as `invoice-INV-1042-v1`.

A file that fails costs nothing. If your data doesn't fit the template, the error names each field to fix. Turn on **Continue On Fail** in the node settings to keep the workflow going and get the error as data.

## What you get back

Each item holds your file in its binary field and these facts in its JSON:

- `id`: the ID of this file in your thirds.ai history
- `status`: `succeeded`
- `template`: the template ID and the exact version used
- `artifact`: the file type, size in bytes, SHA-256, and the date we delete our copy
- `credit`: what this file cost
- `replayed`: `true` when a retry got back a file made earlier
- `idempotencyKey`: the retry key that the node sent

How long we keep your file depends on your [plan](https://thirds.ai/pricing). If you need your own copy, save it in a later step.

## Help

- [thirds.ai docs](https://thirds.ai/docs)
- [API error codes](https://thirds.ai/docs/errors)
- [Retries and downloads](https://thirds.ai/docs/retry-and-download)
- Email support@thirds.ai

## License

[MIT](LICENSE)
