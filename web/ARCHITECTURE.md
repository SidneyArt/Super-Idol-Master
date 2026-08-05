# Web architecture

The web application is organized by business capability. A feature may expose
routes, state hooks, selectors, and UI, but its internal modules are not shared
with sibling features.

## Dependency direction

```text
page composition
  -> feature public interfaces
      -> shared contracts / API client / polling primitive

server bootstrap
  -> feature route factories
      -> explicitly injected domain dependencies
```

The `shared` directory must not import a business feature. Features may import
shared modules, but must not import another feature's private hook. Cross-feature
coordination belongs in page composition or in an explicitly named domain
operation.

## State ownership

- Server state is owned by one query boundary per remote resource.
- UI state belongs to the feature that renders and changes it.
- Form drafts belong to their dialog or composer.
- Derived values are selectors rather than duplicated `useState` values.
- Timers, request cancellation, DOM refs, and queue refs stay behind their
  feature interfaces.

The shared polling primitive cancels requests when its key changes, prevents
overlapping executions, and backs off while the document is hidden. A response
may only update the selection whose key started the request.

## Server feature routes

`server/index.mjs` is the composition root. Route ownership is split into
`runs`, `workspaces`, `assets`, `jobs`, `quality-gates`, `agents`,
`approvals`, `settings`, and `system`. Each route factory declares its
dependencies explicitly so moving domain behavior into the same vertical slice
does not require a controller/service/utils hierarchy.

## Transitional boundary

`app/Studio.tsx` is now the public page composition entry. The current
`StudioApplication` keeps legacy screen markup while state/query behavior is
moved behind feature interfaces. New behavior must be added to a feature module,
not directly to `StudioApplication`; subsequent slices can move the Home and
Task presentation without changing their data owners.
