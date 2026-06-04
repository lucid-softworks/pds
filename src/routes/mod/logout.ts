// POST /mod/logout — clear the mod-session cookie, redirect to login.

import { createFileRoute } from '@tanstack/react-router'
import { modSessionClearHeader } from '~/lib/mod-ui/auth'

export const Route = createFileRoute('/mod/logout')({
  server: {
    handlers: {
      POST: async () => {
        return new Response(null, {
          status: 303,
          headers: {
            location: '/mod/login',
            'set-cookie': modSessionClearHeader(),
          },
        })
      },
    },
  },
})
