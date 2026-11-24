# Thread Graph

A bb plugin that draws every active thread as a force-directed graph. It is a port of the thread graph in [tripplyons/t3code](https://github.com/tripplyons/t3code).

- Each thread is a card. A child thread links to its parent.
- Each subagent still running in a thread is a card with a robot icon, linked to that thread. Clicking it opens the thread.
- A card shows the thread's latest assistant message or thinking. Tool calls never appear.
- The graph shows threads from every project. Archived and hidden threads stay off it.
- Drag to pan, scroll to zoom. The view fits the whole graph each time the page opens.
- The sliders button in the title bar sets the layout forces. They persist in localStorage.
- Cmd+G (Ctrl+G off Mac) opens the graph, or goes back to the page you came from.

## Files

- `app.tsx`: the Graph page, its title-bar control and the Cmd+G command.
- `graph.tsx`: the cards, pan, zoom and fit.
- `graph-logic.ts`: graph building and the force simulation.
- `graph-store.ts`: the layout forces and the settings panel state.
- `thread-details.ts`: reads each thread's timeline for the card preview and running subagents.
- `server.ts`: an empty backend; bb requires one.

## Build and install

```
npm install
bb plugin build .
bb plugin install .
```

After you edit a source file, run `bb plugin build . && bb plugin reload thread-graph`.
