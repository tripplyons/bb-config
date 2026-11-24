# Auto-Collapse Composer

A bb plugin that collapses the message composer inside threads to bb's compact single-line form whenever it is both empty and unfocused.

- Applies only to thread follow-up composers (`[data-follow-up-composer]`); the New Thread screen and inline message editors are untouched.
- Expands as soon as you focus the composer or open any of its menus or footer pickers.
- Stays expanded while the draft contains text, mention pills, attachments, pending uploads, handoff/compaction chips, or active voice input.

## Files

- `app.tsx`: content script that mounts and disposes the app-shell `<style>` element.
- `styles.ts`: selector and compact layout rules matching bb's native collapsed composer styling.
- `server.ts`: minimal backend entry required by bb.
- `app.test.tsx`: unit tests covering registration, lifecycle cleanup, and generated CSS guards.

## Build and install

```sh
npm install
bb plugin build .
bb plugin install .
```

After editing a source file, run `bb plugin build . && bb plugin reload auto-collapse-composer`.
