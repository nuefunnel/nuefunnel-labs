# U-Bahn TV privacy policy

*Last updated: 22 October 2026*

U-Bahn TV is a Claude Code mod by [NueFunnel](https://www.nuefunnel.com). It plays clips from feeds in a pane while Claude works. This policy explains what it does with your data: in short, nothing leaves your computer except the requests needed to fetch the feeds you play.

## What it collects

Nothing. U-Bahn TV has no servers, accounts, analytics or telemetry. It never reads, stores or sends your prompts, Claude's answers, your files or your conversation. It is notified when a turn starts and ends, and uses only the timing to open and close its pane.

## What leaves your computer

To play a feed, U-Bahn TV requests the feed's URL and the clips and pictures it lists, from the hosts that publish them: podsumo.io and regiofokus.de by default, or whatever feeds you set. These are plain requests with no cookies or credentials. Like any web request, they show the feed's host your IP address and the time of the request. What a host does with that is up to its operator's own privacy policy.

## What is stored on your computer

- Under `~/.cache/ubahn-tv/`: each feed's last list, the clips downloaded from it, and frames decoded from them. The mod deletes them itself as they stop being needed. You can delete the folder at any time.
- In Claude Code's plugin store: the clip you last watched, so the next session resumes there.

None of it is sent anywhere.

## Retention

The cache holds the frames of the clip playing and the next two only, a feed's clips only while the feed lists them and up to 500 MB per feed, and the folder of a feed you no longer play for at most 7 days without use. Uninstalling the mod and deleting `~/.cache/ubahn-tv/` removes everything.

## Children

U-Bahn TV is not directed at children under 18.

## Changes and contact

Changes to this policy are made in this file, in the mod's [repository](https://github.com/nuefunnel/nuefunnel-labs). For questions, open an issue in the [repository](https://github.com/nuefunnel/nuefunnel-labs/issues).
