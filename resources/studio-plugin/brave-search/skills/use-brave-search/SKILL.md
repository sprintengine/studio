---
name: use-brave-search
description: Search the live web with Brave — web, news, video, image, local business and AI summary — and read the results honestly. Use when a question needs pages published after your training data, when you need a citable source URL rather than a recollection, when the harness has no web search of its own or its results were thin, when looking for current news or a release date, or when a search returned nothing and you need to know whether the query, the plan or the key was the reason.
---

# Brave Search

Six searches over one API, keyed by `BRAVE_API_KEY`. They are not
interchangeable: each hits a different Brave endpoint with a different result
shape, and asking the web endpoint for news gives you pages that happen to
mention the event rather than coverage of it.

## Reach for it, or don't

Reach for this when the answer is younger than your training data, when you
need a URL somebody else can open, or when the harness's own web search is
absent or came back thin. Do not reach for it to recall something you already
know — a search you did not need still costs a request against the key's
monthly quota, and the quota is what stops working first.

If the harness already has a web search tool, use whichever gives the better
result and say which one you used. Two web searches in one session is not a
problem; quoting one and citing the other is.

## Which search

`brave_web_search` is the default and the only one that can produce a summary
key. `brave_news_search` is for coverage of something that happened, and
defaults to the last 24 hours — widen `freshness` before concluding that
nothing was written. `brave_video_search` and `brave_image_search` answer for
their own media and nothing else. `brave_local_search` and `brave_place_search`
are businesses and points of interest, not web pages.

The parameters worth setting, on the searches that take them: `count` (web
tops out at 20 per page; news and video at 50; images at 200), `offset` for the
next page, `freshness` (`pd`, `pw`, `pm`, `py`, or a date range) to cut stale
pages out of a moving subject, `country` and `search_lang` when the answer is
regional, and `result_filter` to drop result types you are not going to read.
A query is capped at 400 characters and 50 words; a longer one is rejected
rather than truncated, so ask a question rather than pasting a paragraph.

## The summary is a second call

`brave_summarizer` does not take a query. It takes the `key` that
`brave_web_search` returns when it was called with `summary: true`, so it is
always the second of two calls, and a summarizer call without a preceding web
search has nothing to work from. `inline_references: true` puts the source URLs
into the summary, which is the difference between a summary you can cite and
one you cannot.

## What the plan gates

`extra_snippets` is Pro-only on web and news. Full local search is Pro-only and
**falls back to an ordinary web search** rather than failing — so a local
search that reads like a list of web pages is a plan answer, not an empty area.
Summarization is a paid feature on Brave's side. When a result looks
unexpectedly like plain web output, check the plan before blaming the query.

## When it returns nothing

Three different failures read alike, and only one of them is about the query.

A missing or invalid `BRAVE_API_KEY` fails the call itself: the server starts
fine without a key and only discovers it has none when it tries to search. If
every search fails identically, that is the key, and the fix is a person's —
say the variable is not set in the environment this agent was launched in, and
do not try to work around it.

A quota that has run out fails the same way from the caller's side. Brave's
free tier is rate-limited per second as well as per month, so a burst of
searches can fail while a single one succeeds a moment later; one retry after a
pause distinguishes the two.

An empty result set with a successful call is the query. Shorten it, drop the
site-specific operators, or widen `freshness` — Brave's index is not Google's
and a query tuned for one is not tuned for the other.

## Reading results

Brave returns the web's claims, not facts. A search result is a citation, not
evidence: quote what a page says with its URL, and say when the top results
disagree with each other rather than picking the first one. `text_decorations`
is on by default and wraps matched terms in highlight markers — strip them
before quoting a snippet, or the quote carries markup the page does not have.
