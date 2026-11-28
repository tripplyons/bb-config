# Auto-Collapse Composer

A bb plugin that keeps the message composer unfocused when entering a thread and collapses it to bb's compact single-line form whenever it is both empty and unfocused.

- Applies only to primary thread follow-up composers (`[data-follow-up-composer]`); the New Thread screen and inline message editors are untouched.
- Suppresses bb's automatic composer focus on thread entry (initial load, SPA navigation, or newly mounted thread composers) while keeping explicit clicks, keyboard shortcuts, and post-entry actions like "Add to chat" working normally.
- Expands as soon as you focus the composer or open any of its menus or footer pickers.
- Stays expanded while the draft contains text, mention pills, attachments, pending uploads, handoff/compaction chips, or active voice input.

## Files

- `app.tsx`: content script that mounts and disposes the app-shell `<style>` element and thread-entry focus suppression.
- `focus.ts`: suppresses programmatic auto-focus on thread entry without interfering with intentional user focus.
- `styles.ts`: selector and compact layout rules matching bb's native collapsed composer styling.
- `server.ts`: minimal backend entry required by bb.
- `app.test.tsx` / `focus.test.ts`: unit tests covering registration, lifecycle cleanup, focus suppression, and generated CSS guards.

## Build and install

```sh
npm install
bb plugin build .
bb plugin install .
```

After editing a source file, run `bb plugin build . && bb plugin reload auto-collapse-composer`.
