// POST /admin/logout — clears the admin-session cookie, redirects to
// /admin/login. No CSRF on logout: an attacker who can forge logout only
// inconveniences the operator (they re-log in); the worst case is benign.

import { createFileRoute } from '@tanstack/react-router'
import { adminSessionClearHeader } from '~/lib/admin-ui/auth'

export const Route = createFileRoute('/admin/logout')({
  server: {
    handlers: {
      POST: async () => {
        return new Response(null, {
          status: 303,
          headers: {
            location: '/admin/login',
            'set-cookie': adminSessionClearHeader(),
          },
        })
      },
    },
  },
})
