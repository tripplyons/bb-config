# Auto Sidebar

A bb plugin that replaces the sidebar thread list with three automatically managed sections—**Working**, **Active**, and **Archived**—with no manual folders, custom sections, or pinned sections.

- **Working**: threads that are currently running (active/starting/stopping/provisioning, background agents/commands/workflows, plan mode, or a running plugin row status) or waiting (pending interaction, queued message waiting to send, pending start, or waiting for host).
- **Active**: non-archived threads that are not running or waiting (including finished unread or errored threads), sorted newest-updated first.
- **Archived**: archived threads sorted newest-archived first, collapsed by default, with a **Show more** button to load older pages.
- **Child nesting**: child threads nest under their parent within the same lifecycle. If any descendant is working, the root tree appears in **Working**.
- **Row actions**: hover **Archive/Unarchive** and **More actions**, right-click context menu, inline rename, drag-to-split, and bb keyboard shortcut targets.

## Files

- `app.tsx`: registers the `experimental_threadList` slot (`auto-sidebar`).
- `thread-list.tsx`: sidebar component, section collapsing/reveal state, pagination, and thread rows.
- `sidebar-logic.ts`: pure thread grouping, parent/child tree building, reveal resolution, and persisted state validation.
- `server.ts`: minimal backend entry required by bb.
- `sidebar-logic.test.ts` and `app.test.tsx`: unit and component tests.

## Build and install

```sh
npm install
bb plugin build .
bb plugin install . --yes
```

After editing a source file, run `bb plugin build . && bb plugin reload auto-sidebar`.
