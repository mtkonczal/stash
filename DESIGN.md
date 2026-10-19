---
version: alpha
name: Stash
description: A quiet personal reading library with reliable saved audio.
colors:
  primary: '#6366f1'
  background: '#ffffff'
  surface: '#f9fafb'
  text: '#1f2937'
  secondary: '#6b7280'
  border: '#e5e7eb'
typography:
  sans:
    fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
rounded:
  DEFAULT: '8px'
  lg: '12px'
spacing:
  audio-padding: '12px 16px'
components:
  audio-status: {}
  button: {}
---

# Stash Design System

## Overview

### Creative North Star
A personal reading shelf: article text leads, with compact utility controls.
Preserve the established interface while repairing the audio workflow.

### Product context and register
Single-user English-language product for reading and listening on Mac and phone.
The user's brief selects free local generation and the Sky voice. There is no
Japan-market scope. Product utility, not a marketing page. No visual redesign.
Existing runtime token owner: `web/styles.css` root and dark-theme declarations.
This file records those existing values; it does not generate a second token set.
Behavior and canonical owners: `UX-CONTRACT.md`.

## Colors
Use existing primary, background, surface, text, secondary, and border tokens.
Audio status uses text plus a label, never color alone. Preserve light/dark themes.

## Typography
Use the existing system sans stack. Article prose retains its current size and
line height. Audio status is 14px, with a semibold state title and regular detail.

## Layout
Preserve sidebar, list, and reading pane. Audio status stays above the article
title. Its action wraps on narrow screens and has a 44px minimum height.

## Elevation & Depth
Audio status uses a surface and border, without a new shadow or floating layer.

## Shapes
Reuse the 8px control radius and 12px panel radius. No new icon family.

## Components

### Foundational visual states
Only a live generating job gets an animated indicator. Queued/offline/failed
states have explicit text. Respect reduced motion. Errors remain visible with
a recovery button. Requests disable the button while pending.

### Buttons and actions
Reuse `.btn.secondary`. Labels are Generate audio, Retry audio, Check again,
Regenerate audio, and Load audio, each tied to the corresponding action. Preserve focus outlines.

### Navigation and data display
The reading pane owns audio status. Closing or changing the article cancels
polling and invalidates in-flight responses without changing list position.

### Forms and overlays
No new form or dialog. Existing native playback-speed select is retained;
platform-owned popup geometry is accepted for this simple playback control.

### Iconography
Retain existing play/pause SVGs. The status spinner is decorative and hidden
from accessibility APIs; the adjacent live-region text communicates the state.

### Motion
Existing spinner motion is limited to active generation; reduced motion disables
it. Playback starts only after a user's Play action.

### Content and data visualization
Plain English. Measured progress is sections completed, not an invented ETA.
Waiting for a sleeping/offline Mac must be stated directly. Future recordings
show their expiry date. Expired recordings offer Regenerate audio; existing
active recordings have no expiry. Archived status explains that unarchiving
is required before generation.

## Do's and Don'ts

- Do preserve active existing recordings and the user's reading position.
- Do use the existing runtime tokens and shared action classes.
- Don't infer generation from a missing file or hide failures behind a spinner.
- Don't introduce paid services, celebrity voice imitation, or a visual redesign.
