# Readback privacy policy

*Last updated: 12 November 2026*

Readback is an RSS reader for the ChatGPT desktop app, by [NueFunnel](https://www.nuefunnel.com). In short: **everything Readback does happens on your Mac.** It has no servers, no accounts, no analytics and no telemetry. Your subscriptions, articles and reading history stay in one folder on your computer and are never sent to NueFunnel or anyone else.

## What it collects

Nothing. Readback has no server of its own to send anything to. The ChatGPT app starts a small Readback program on your Mac while it's open, and that program is all there is.

## What leaves your computer

Readback itself makes only the requests a feed reader needs, and only to the sites you subscribe to:

- **Feeds:** each feed you follow is checked about every 30 minutes while ChatGPT is open.
- **Images and icons:** pictures in articles, and each site's icon, are downloaded once from the site that serves them.
- **Adding a feed:** when you paste a website address, Readback opens that page to find its feed.

These are plain requests with no cookies or credentials. Each carries a user agent that names Readback and links to this repository. Like any web request, they show the site your IP address and the time. What a site does with that is up to its own privacy policy.

## What goes to ChatGPT, and when

Readback runs inside the ChatGPT app, but **nothing about what you read is sent to ChatGPT until you ask.** Opening Readback, reading, starring and marking articles all stay on your Mac.

Something goes to ChatGPT only when you ask it something:

- **Ask, Explain or Fact-check** on a selection sends your question, the selected passage and the open article's text to the chat.
- **Asking in the chat about your feeds**, for example "What's new today?", lets ChatGPT read article titles or an article's text through Readback's tools, to answer you.
- **Importing an OPML file by asking in the chat** gives ChatGPT the file's path.

What you send to ChatGPT is handled by OpenAI under [its privacy policy](https://openai.com/policies/privacy-policy/) and your ChatGPT settings, like anything else you type into the chat. Readback doesn't control that.

## What is stored on your computer

Everything is in `~/Library/Application Support/Readback/`:

- `readback.sqlite`: your subscriptions and folders, the articles fetched from them, what you've read and starred, and reader settings such as pane widths.
- `images/`: images from articles, shrunk if large.
- `events.log`: a record of what Readback did, such as feeds checked and errors, to help when something goes wrong. It doesn't record what you read or ask.

Readback also reads, only when you ask it to, NetNewsWire's subscription list on this Mac and OPML files you choose. When you export, it writes an OPML file to `~/Downloads`.

## Retention

Readback cleans up once a day. Read articles older than 90 days are deleted; unread and starred ones are kept. The image cache is capped at 300 MB, and the least recently viewed images are deleted first. Unsubscribing from a feed deletes its articles.

To remove everything, uninstall Readback in the ChatGPT app and delete `~/Library/Application Support/Readback/`.

## Children

Readback is not directed at children under 18.

## Changes and contact

Changes to this policy are made in this file, in the plugin's [repository](https://github.com/nuefunnel/nuefunnel-labs). For questions, open an issue in the [repository](https://github.com/nuefunnel/nuefunnel-labs/issues).
