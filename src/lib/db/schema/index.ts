// Schema barrel. Each subsystem owns a file under this directory and adds a
// re-export line below as it ships. Drizzle picks up everything we re-export.
//
// Convention: subsystem file names mirror the chapter that introduces the
// tables (accounts → ch 12, records → ch 14, etc).

export * from './accounts'
export * from './records'
export * from './blobs'
export * from './sequencer'
export * from './app_passwords'
export * from './email_tokens'
export * from './invite_codes'
export * from './migration'
export * from './oauth'
