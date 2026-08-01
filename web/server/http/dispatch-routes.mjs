export async function dispatchRoutes(routes, context) {
  for (const route of routes) {
    if (await route(context)) return true;
  }
  return false;
}
