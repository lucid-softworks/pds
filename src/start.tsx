import { createStart } from '@tanstack/react-start'

// TanStack Start's createStart wires up the SSR + client entry from a single
// declaration. Each route file is auto-discovered by the router plugin.
export const startInstance = createStart(() => ({}))
