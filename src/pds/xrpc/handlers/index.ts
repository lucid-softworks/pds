// XRPC handler registry — one place that knows about every endpoint.
//
// As new handler files land, add them here. The registry is built once at
// import time; the TanStack route imports this module and dispatches.

import { HandlerRegistry } from '../server'

// server / account / session
import * as createAccount from './com.atproto.server.createAccount'
import * as createSession from './com.atproto.server.createSession'
import * as refreshSession from './com.atproto.server.refreshSession'
import * as deleteSession from './com.atproto.server.deleteSession'
import * as getSession from './com.atproto.server.getSession'
import * as describeServer from './com.atproto.server.describeServer'
// app passwords
import * as createAppPassword from './com.atproto.server.createAppPassword'
import * as listAppPasswords from './com.atproto.server.listAppPasswords'
import * as revokeAppPassword from './com.atproto.server.revokeAppPassword'
// email + password reset
import * as requestEmailConfirmation from './com.atproto.server.requestEmailConfirmation'
import * as confirmEmail from './com.atproto.server.confirmEmail'
import * as requestEmailUpdate from './com.atproto.server.requestEmailUpdate'
import * as updateEmail from './com.atproto.server.updateEmail'
import * as requestPasswordReset from './com.atproto.server.requestPasswordReset'
import * as resetPassword from './com.atproto.server.resetPassword'
// account lifecycle
import * as checkAccountStatus from './com.atproto.server.checkAccountStatus'
import * as deactivateAccount from './com.atproto.server.deactivateAccount'
import * as activateAccount from './com.atproto.server.activateAccount'
import * as requestAccountDelete from './com.atproto.server.requestAccountDelete'
import * as deleteAccount from './com.atproto.server.deleteAccount'
// invite codes
import * as createInviteCode from './com.atproto.server.createInviteCode'
import * as createInviteCodes from './com.atproto.server.createInviteCodes'
import * as getAccountInviteCodes from './com.atproto.server.getAccountInviteCodes'
import * as checkSignupQueue from './com.atproto.temp.checkSignupQueue'
// identity
import * as resolveHandle from './com.atproto.identity.resolveHandle'
import * as updateHandle from './com.atproto.identity.updateHandle'
import * as requestPlcOperationSignature from './com.atproto.identity.requestPlcOperationSignature'
import * as signPlcOperation from './com.atproto.identity.signPlcOperation'
// repo
import * as createRecord from './com.atproto.repo.createRecord'
import * as putRecord from './com.atproto.repo.putRecord'
import * as deleteRecord from './com.atproto.repo.deleteRecord'
import * as getRecord from './com.atproto.repo.getRecord'
import * as listRecords from './com.atproto.repo.listRecords'
import * as applyWrites from './com.atproto.repo.applyWrites'
import * as describeRepo from './com.atproto.repo.describeRepo'
import * as uploadBlob from './com.atproto.repo.uploadBlob'
// sync
import * as getBlob from './com.atproto.sync.getBlob'
import * as getBlocks from './com.atproto.sync.getBlocks'
import * as getLatestCommit from './com.atproto.sync.getLatestCommit'
import * as syncGetRecord from './com.atproto.sync.getRecord'
import * as getRepo from './com.atproto.sync.getRepo'
import * as getRepoStatus from './com.atproto.sync.getRepoStatus'
import * as listRepos from './com.atproto.sync.listRepos'
import * as listBlobs from './com.atproto.sync.listBlobs'
import * as subscribeRepos from './com.atproto.sync.subscribeRepos'
// migration
import * as getServiceAuth from './com.atproto.server.getServiceAuth'
import * as reserveSigningKey from './com.atproto.server.reserveSigningKey'
import * as importRepo from './com.atproto.repo.importRepo'
import * as listMissingBlobs from './com.atproto.repo.listMissingBlobs'
import * as requestAccountMigrate from './com.atproto.server.requestAccountMigrate'
// bsky-app preferences (PDS-served despite the app.bsky.* namespace)
import * as bskyGetPreferences from './app.bsky.actor.getPreferences'
import * as bskyPutPreferences from './app.bsky.actor.putPreferences'
// admin
import * as adminGetAccountInfo from './com.atproto.admin.getAccountInfo'
import * as adminGetAccountInfos from './com.atproto.admin.getAccountInfos'
import * as adminUpdateAccountStatus from './com.atproto.admin.updateAccountStatus'
import * as adminUpdateAccountHandle from './com.atproto.admin.updateAccountHandle'
import * as adminUpdateAccountEmail from './com.atproto.admin.updateAccountEmail'
import * as adminSendEmail from './com.atproto.admin.sendEmail'
import * as adminDeleteAccount from './com.atproto.admin.deleteAccount'
import * as adminGetAuditLog from './com.atproto.admin.getAuditLog'
// admin: invite governance
import * as adminDisableAccountInvites from './com.atproto.admin.disableAccountInvites'
import * as adminEnableAccountInvites from './com.atproto.admin.enableAccountInvites'
import * as adminDisableInviteCodes from './com.atproto.admin.disableInviteCodes'
import * as adminGetInviteCodes from './com.atproto.admin.getInviteCodes'
// admin: subject-level moderation + password reset
import * as adminUpdateSubjectStatus from './com.atproto.admin.updateSubjectStatus'
import * as adminGetSubjectStatus from './com.atproto.admin.getSubjectStatus'
import * as adminUpdateAccountPassword from './com.atproto.admin.updateAccountPassword'
// ozone-shaped moderation surface (chapter 24)
import * as ozoneEmitEvent from './tools.ozone.moderation.emitEvent'
import * as ozoneQueryEvents from './tools.ozone.moderation.queryEvents'
import * as ozoneQueryStatuses from './tools.ozone.moderation.queryStatuses'
import * as ozoneGetEvent from './tools.ozone.moderation.getEvent'
import * as ozoneGetRepo from './tools.ozone.moderation.getRepo'
import * as ozoneGetRecord from './tools.ozone.moderation.getRecord'
// label surface (chapter 24)
import * as labelQueryLabels from './com.atproto.label.queryLabels'
import * as labelSubscribeLabels from './com.atproto.label.subscribeLabels'
// ozone-extension surfaces: team / setting / set
import * as ozoneTeamList from './tools.ozone.team.listMembers'
import * as ozoneTeamAdd from './tools.ozone.team.addMember'
import * as ozoneTeamUpdate from './tools.ozone.team.updateMember'
import * as ozoneTeamDelete from './tools.ozone.team.deleteMember'
import * as ozoneSettingUpsert from './tools.ozone.setting.upsertOption'
import * as ozoneSettingList from './tools.ozone.setting.listOptions'
import * as ozoneSettingRemove from './tools.ozone.setting.removeOptions'
import * as ozoneSetUpsert from './tools.ozone.set.upsertSet'
import * as ozoneSetDelete from './tools.ozone.set.deleteSet'
import * as ozoneSetQuery from './tools.ozone.set.querySets'
import * as ozoneSetGetValues from './tools.ozone.set.getValues'
import * as ozoneSetAddValues from './tools.ozone.set.addValues'
import * as ozoneSetDeleteValues from './tools.ozone.set.deleteValues'
// moderation
import * as createReport from './com.atproto.moderation.createReport'
// identity (migration-destination)
import * as getRecommendedDidCredentials from './com.atproto.identity.getRecommendedDidCredentials'
import * as submitPlcOperation from './com.atproto.identity.submitPlcOperation'

export const registry = new HandlerRegistry()
  .register(createAccount.nsid, createAccount.def)
  .register(createSession.nsid, createSession.def)
  .register(refreshSession.nsid, refreshSession.def)
  .register(deleteSession.nsid, deleteSession.def)
  .register(getSession.nsid, getSession.def)
  .register(describeServer.nsid, describeServer.def)
  .register(createAppPassword.nsid, createAppPassword.def)
  .register(listAppPasswords.nsid, listAppPasswords.def)
  .register(revokeAppPassword.nsid, revokeAppPassword.def)
  .register(requestEmailConfirmation.nsid, requestEmailConfirmation.def)
  .register(confirmEmail.nsid, confirmEmail.def)
  .register(requestEmailUpdate.nsid, requestEmailUpdate.def)
  .register(updateEmail.nsid, updateEmail.def)
  .register(requestPasswordReset.nsid, requestPasswordReset.def)
  .register(resetPassword.nsid, resetPassword.def)
  .register(checkAccountStatus.nsid, checkAccountStatus.def)
  .register(deactivateAccount.nsid, deactivateAccount.def)
  .register(activateAccount.nsid, activateAccount.def)
  .register(requestAccountDelete.nsid, requestAccountDelete.def)
  .register(deleteAccount.nsid, deleteAccount.def)
  .register(createInviteCode.nsid, createInviteCode.def)
  .register(createInviteCodes.nsid, createInviteCodes.def)
  .register(getAccountInviteCodes.nsid, getAccountInviteCodes.def)
  .register(checkSignupQueue.nsid, checkSignupQueue.def)
  .register(resolveHandle.nsid, resolveHandle.def)
  .register(updateHandle.nsid, updateHandle.def)
  .register(requestPlcOperationSignature.nsid, requestPlcOperationSignature.def)
  .register(signPlcOperation.nsid, signPlcOperation.def)
  .register(createRecord.nsid, createRecord.def)
  .register(putRecord.nsid, putRecord.def)
  .register(deleteRecord.nsid, deleteRecord.def)
  .register(getRecord.nsid, getRecord.def)
  .register(listRecords.nsid, listRecords.def)
  .register(applyWrites.nsid, applyWrites.def)
  .register(describeRepo.nsid, describeRepo.def)
  .register(uploadBlob.nsid, uploadBlob.def)
  .register(getBlob.nsid, getBlob.def)
  .register(getBlocks.nsid, getBlocks.def)
  .register(getLatestCommit.nsid, getLatestCommit.def)
  .register(syncGetRecord.nsid, syncGetRecord.def)
  .register(getRepo.nsid, getRepo.def)
  .register(getRepoStatus.nsid, getRepoStatus.def)
  .register(listRepos.nsid, listRepos.def)
  .register(listBlobs.nsid, listBlobs.def)
  .register(subscribeRepos.nsid, subscribeRepos.def)
  .register(getServiceAuth.nsid, getServiceAuth.def)
  .register(reserveSigningKey.nsid, reserveSigningKey.def)
  .register(importRepo.nsid, importRepo.def)
  .register(listMissingBlobs.nsid, listMissingBlobs.def)
  .register(requestAccountMigrate.nsid, requestAccountMigrate.def)
  .register(bskyGetPreferences.nsid, bskyGetPreferences.def)
  .register(bskyPutPreferences.nsid, bskyPutPreferences.def)
  .register(adminGetAccountInfo.nsid, adminGetAccountInfo.def)
  .register(adminGetAccountInfos.nsid, adminGetAccountInfos.def)
  .register(adminUpdateAccountStatus.nsid, adminUpdateAccountStatus.def)
  .register(adminUpdateAccountHandle.nsid, adminUpdateAccountHandle.def)
  .register(adminUpdateAccountEmail.nsid, adminUpdateAccountEmail.def)
  .register(adminSendEmail.nsid, adminSendEmail.def)
  .register(adminDeleteAccount.nsid, adminDeleteAccount.def)
  .register(adminGetAuditLog.nsid, adminGetAuditLog.def)
  .register(createReport.nsid, createReport.def)
  .register(getRecommendedDidCredentials.nsid, getRecommendedDidCredentials.def)
  .register(submitPlcOperation.nsid, submitPlcOperation.def)
  .register(adminDisableAccountInvites.nsid, adminDisableAccountInvites.def)
  .register(adminEnableAccountInvites.nsid, adminEnableAccountInvites.def)
  .register(adminDisableInviteCodes.nsid, adminDisableInviteCodes.def)
  .register(adminGetInviteCodes.nsid, adminGetInviteCodes.def)
  .register(adminUpdateSubjectStatus.nsid, adminUpdateSubjectStatus.def)
  .register(adminGetSubjectStatus.nsid, adminGetSubjectStatus.def)
  .register(adminUpdateAccountPassword.nsid, adminUpdateAccountPassword.def)
  .register(ozoneEmitEvent.nsid, ozoneEmitEvent.def)
  .register(ozoneQueryEvents.nsid, ozoneQueryEvents.def)
  .register(ozoneQueryStatuses.nsid, ozoneQueryStatuses.def)
  .register(ozoneGetEvent.nsid, ozoneGetEvent.def)
  .register(ozoneGetRepo.nsid, ozoneGetRepo.def)
  .register(ozoneGetRecord.nsid, ozoneGetRecord.def)
  .register(labelQueryLabels.nsid, labelQueryLabels.def)
  .register(labelSubscribeLabels.nsid, labelSubscribeLabels.def)
  .register(ozoneTeamList.nsid, ozoneTeamList.def)
  .register(ozoneTeamAdd.nsid, ozoneTeamAdd.def)
  .register(ozoneTeamUpdate.nsid, ozoneTeamUpdate.def)
  .register(ozoneTeamDelete.nsid, ozoneTeamDelete.def)
  .register(ozoneSettingUpsert.nsid, ozoneSettingUpsert.def)
  .register(ozoneSettingList.nsid, ozoneSettingList.def)
  .register(ozoneSettingRemove.nsid, ozoneSettingRemove.def)
  .register(ozoneSetUpsert.nsid, ozoneSetUpsert.def)
  .register(ozoneSetDelete.nsid, ozoneSetDelete.def)
  .register(ozoneSetQuery.nsid, ozoneSetQuery.def)
  .register(ozoneSetGetValues.nsid, ozoneSetGetValues.def)
  .register(ozoneSetAddValues.nsid, ozoneSetAddValues.def)
  .register(ozoneSetDeleteValues.nsid, ozoneSetDeleteValues.def)
