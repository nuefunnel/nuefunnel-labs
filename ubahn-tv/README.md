# U-Bahn TV

What do you do while Claude works? On the Nuremberg U-Bahn you'd watch the passenger-TV screens: VAG quizzes, local trivia, the weather, and ads for things around town. U-Bahn TV brings those screens into Claude Code. When a turn runs longer than 10 seconds, a pane opens beside the conversation and plays a loop of clips: by default, episode cards from [Podsumo](https://podsumo.io/) mixed with the current rotation from [regiofokus.de](https://regiofokus.de/player.php?site=NBG_MET). When the turn ends, the pane closes, and the next long wait picks up where the last one stopped.

It isn't limited to these: give it other [feeds](#feeds) of clips and pictures, such as any Media RSS feed, and it plays them mixed into one loop. With two feeds by default, one that is down never leaves the pane blank.

It's a Claude Code [mod](https://code.claude.com/docs/en/plugins/mods/overview): JavaScript that runs inside Claude Code and draws its own pane.

**Why Nuremberg?** [NueFunnel](https://www.nuefunnel.com) was born in Nuremberg, and is named after the Nuremberg Funnel (Nürnberger Trichter). So the city's own U-Bahn screens were the natural first feed for this mod.

## Requirements

- **Claude Code v2.1.287 or later**, in the terminal or the Desktop app. The Desktop app has no image element, so it shows a fast slideshow there: 10 stills a second by default instead of video.
- **In the terminal, the kitty graphics protocol:** Ghostty or kitty.
- **No tmux.** tmux doesn't pass pictures through. In tmux the pane still opens, but shows a notice in place of the video. Wrappers that start Claude Code inside tmux, such as `claude-auto-retry`, have the same effect.
- **`curl` and `ffmpeg`** (`brew install ffmpeg`). The mod also looks in `/opt/homebrew/bin` and `/usr/local/bin`.
- **A wide window for opening on its own:** 144 columns, or 110 once you've opened the pane yourself. `/ubahn` opens it at any width.

## Install

```
/plugin marketplace add nuefunnel/nuefunnel-labs
/plugin install ubahn-tv@nuefunnel-labs
```

During development, load it for one session instead, with hot reload on save:

```
claude --plugin-dir /path/to/nuefunnel-labs/ubahn-tv
```

Don't do both at once: an installed copy takes the name first, so the `--plugin-dir` copy doesn't load.

## Use

| Command | What it does |
| :- | :- |
| `/ubahn` | Opens or closes the pane. A pane you open stays open across turns. |
| `/ubahn next` | Skips to the next clip |
| `/ubahn status` | Shows each feed (how it's read, clip count, last fetch, whether that copy came from disk, any error, a fetch under way), the timing, the cache folder, and whether tmux or a missing tool is in the way |

Close the pane with its ✕, or with Ctrl+X then X.

## Settings

Set these in the dialog that `/plugin install` opens, later with `/plugin configure ubahn-tv@nuefunnel-labs`, or as rows in `/config`.

| Setting | Default | Meaning |
| :- | :- | :- |
| `feeds` | `https://podsumo.io/mrss/_IMSyPwN0vwnkpQH-69kKw https://regiofokus.de/content/NBG_MET/playlist.json` | The [feeds](#feeds) to play, separated by spaces or commas. Set only the regiofokus.de URL for the screens as they look on board, in German with the VAG red bar |
| `auto_open_delay_seconds` | `10` | How long a turn runs before the pane opens; `0` opens it at once |
| `fps` | `12` | Playback frame rate (4–30). Higher is smoother and uses more disk space |
| `desktop_fps` | `10` | Stills per second in the Desktop app (1–10). Each still is about 20 KB sent with a redraw, so lower sends less. 10 is Claude Code's limit on redraws a second |
| `timing` | `hybrid` | `hybrid` plays one frame per tick and catches up when more than 250 ms behind; `ticks` plays one frame per tick, so a busy turn can stretch a clip; `wall` follows the clock exactly and may skip frames |
| `verbose_log` | `false` | Writes every tick and frame to the debug log |

## Feeds

`feeds` takes one or more URLs. Each is read by whichever adapter fits it:

| URL | Read as |
| :- | :- |
| `https://regiofokus.de/content/<network>/playlist.json` | A regiofokus.de passenger-TV network, through an adapter built into the mod that turns the public web player's playlist into the same items a Media RSS feed gives, filtered like the web player. Networks: `NBG_MET` (Nürnberg U-Bahn), `AUG_BUS`, `BYU_BUS`, `ANS_BUS`, `ANS_BRC`, `ULM_BUS`, `ULM_TRA` |
| Anything else | A [Media RSS](https://rssboard.org/media-rss) feed |

Several feeds play mixed into one loop, a clip from each in turn. A feed that can't be read is skipped, and the others keep playing; `/ubahn status` says why. Each feed's last good answer is kept on disk, so a feed that is down still plays the clips it listed last time, in this session and the next.

The header and the credit line always name the feed of the clip on screen. The pane's own words are neutral English ("Up next", "From screenfeed.com"), except while every feed is a regiofokus.de network: then it looks like the screens on board, in German with the VAG red bar. A mixed loop never switches language from clip to clip.

Clips and pictures arrive finished: the pane shows each one as it is. From a Media RSS feed the mod reads:

| Field | Used for | When it's missing |
| :- | :- | :- |
| `<media:content url type medium duration>`, also inside `<media:group>`, or `<enclosure>` | The clip or picture. Video wins over a picture, then the largest up to 1920 px wide | The item is skipped, as are audio and web pages |
| `duration` | Seconds a picture stays on screen; a video plays its own length | 10 seconds |
| `<dcterms:valid>start=…; end=…</dcterms:valid>` | Not shown before the start, skipped after the end | Always shown |
| `<title>` | The caption and the "Als nächstes" line | No caption |
| `<link>` | The "→ mehr erfahren" link | No link |
| `<guid>` | Where a new session resumes | The media URL |
| `<channel><title>`, `<channel><link>` | The pane's header and the credit line | The feed's host name |
| `<channel><ttl>` | Minutes until the feed is fetched again (at least 5) | An hour |

For example, Screenfeed's public demo feed `https://kitchen.screenfeed.com/feed/vrqg8c8fax6emtkpbs446s17s.xml` shows finished picture cards for 5 seconds each.

## How it works

1. **Feeds:** at session start the mod first reads each feed's last good answer from its `feed.json`, so those clips play at once, then fetches every feed that is due. Nothing waits for a fetch: as each feed arrives it joins the loop around the clip playing and the clips due next start downloading, so a slow or dead feed holds up neither the pane nor the other feeds (`$.http.fetch` gives up on a host that doesn't answer after 30 seconds). A feed is due when it has no copy, when its copy is older than its `ttl` (an hour unless it says), when the day changes, or when the loop wraps, so a session left open overnight still gets fresh clips. A feed is never fetched twice at once. A feed that fails keeps playing its last copy and is tried again after five minutes. Expired clips, and clips that fail to download or decode, are skipped. A clip a fresh answer no longer lists plays to its end, then leaves the loop.
2. **Cache:** each feed has its own folder, `~/.cache/ubahn-tv/feeds/<feed key>/`. `feed.json` holds the feed's last good answer as it came, with when it was fetched; a failed fetch never replaces it, and it is written aside and renamed into place, so sessions sharing it never read half a file. Clips are downloaded with `curl` into its `clips/` and decoded with `ffmpeg`: for a terminal into PNG frames, 800 px wide, at the playback rate; for the Desktop app into JPEG stills, 640 px wide, at `desktop_fps`, in `stills/<rate>fps-<width>px/`. Each is only made when a surface that draws it is attached. A decode writes to a temporary folder, which is renamed into place only when it finishes. What keeps the cache in bounds:
   - Only the current clip and the next two are kept as frames, about 20 MB each. A frames folder is removed only after three minutes untouched, so concurrent sessions don't delete each other's frames.
   - Clips a feed no longer lists, or whose end date has passed, are deleted from that feed's folder only.
   - A feed's clips are kept up to 500 MB. Past that, the clips played longest ago are deleted (never the current clip or the next two), and downloaded again if they come round.
   - The folder of a feed this session doesn't play is deleted once nothing in it has been touched for 7 days. Until then another session, with other feeds set, may still be playing it.
3. **Playback:** in the terminal, the pane draws a keyed `Image` sized to 16:9. A 12 fps timer swaps the picture with `$.ui.blit`, and the terminal reads each frame file itself, so no pixel data goes through Claude Code. The Desktop app has no `Image` and no blit, so the timer runs at `desktop_fps` and redraws the pane for each new still, which goes into an `Svg` as a base64 data URI, about 20 KB.
4. **Lifecycle:** `turn.start` arms a timer, the pane opens when it fires, and `turn.complete` closes it. The pane opens on time with whatever there is to play; if no feed has answered yet and none has a copy on disk, it says the feeds are loading and starts playing when the first one arrives. The playback position is saved per list of feeds, so a new session resumes there.

The code that knows a source's format lives in `hooks/adapters/`; everything past it works on one kind of item. Supporting a new kind of source means adding an adapter there.

## What it runs, fetches and stores

U-Bahn TV collects nothing and sends nothing anywhere. Everything it does is listed here; [PRIVACY.md](PRIVACY.md) has the privacy policy.

- **Fetches** each feed URL in the `feeds` setting, through Claude Code's `$.http.fetch`: by default Podsumo's Media RSS feed and the regiofokus.de playlist, the latter with a `?timestamp=` cache-buster as its web player adds. A feed is fetched at session start when it is due, then again when it's due under the rules in [How it works](#how-it-works). These are plain GET requests with no cookies or credentials, so a feed's host sees your IP address and the time, as it would from a browser.
- **Downloads** the clips and pictures that a feed lists, with `curl`, from whatever host the feed points them at. Only the clip playing and the next two are fetched ahead.
- **Runs** `curl` and `ffmpeg` to download and decode clips, plus `mkdir`, `mv`, `rm`, `touch` and `find` inside its cache folder. It runs nothing else.
- **Writes** only under `~/.cache/ubahn-tv/`: each feed's `feed.json`, its clips, and decoded frames. [How it works](#how-it-works) says what keeps that folder in bounds. It also keeps the playback position in Claude Code's plugin store, so a new session resumes where the last one stopped.
- **Reads** the `HOME` and `TMUX` environment variables, to find its cache folder and to know whether pictures can show.
- **Listens** for turns starting and ending, to open and close the pane. It uses only their timing: it never reads, keeps or sends your prompts, Claude's answers, your files or your conversation.
- **Logs** to Claude Code's debug log only, and only when you start a session with `--debug-file`.

## Troubleshooting

Start a session with a debug log and filter for the mod's lines:

```
claude --debug-file ~/ubahn.log --plugin-dir …/ubahn-tv
grep ubahn ~/ubahn.log
```

For every clip, `clip-end` lines give the expected and actual length, ticks per second, the largest gap between ticks, and the number of skipped frames. `prepare` lines give download and decode times. Turn on `verbose_log` for a line per tick.

| Symptom | Cause |
| :- | :- |
| The clip's name shows in place of the picture | The terminal can't draw images: tmux, or a terminal without the kitty protocol |
| The pane never opens on its own | The window is under 144 columns. Open it once with `/ubahn`, and 110 columns is then enough |
| "Fehlt: ffmpeg" | Run `brew install ffmpeg` |
| A feed's clips never show | Run `/ubahn status`: it gives the feed's error. A Media RSS item needs an image or video in `media:content` or `<enclosure>` |

## Content

All clips belong to their publishers. The pane names each clip's source on its last line. Of the default feeds, Podsumo's is published by NueFunnel, which also makes this plugin. The other is streamed from regiofokus.de, operated by Redlof Medien GmbH & Co. KG: this plugin plays the public web player's feed and stores nothing beyond a local cache. Before playing another feed, check that its publisher allows it.
