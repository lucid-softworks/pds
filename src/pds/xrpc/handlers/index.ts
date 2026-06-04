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
import * as tempFetchLabels from './com.atproto.temp.fetchLabels'
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
// bsky-app proxy stubs — forward to api.bsky.app when no Atproto-Proxy
// header is set, with read-after-write munges applied inside the
// proxy path. Matches the upstream PDS's behavior of serving these
// endpoints with a hard-coded AppView target.
import * as bskyGetProfile from './app.bsky.actor.getProfile'
import * as bskyGetProfiles from './app.bsky.actor.getProfiles'
import * as bskyGetAuthorFeed from './app.bsky.feed.getAuthorFeed'
import * as bskyGetTimeline from './app.bsky.feed.getTimeline'
import * as bskyGetActorLikes from './app.bsky.feed.getActorLikes'
import * as bskyGetPostThread from './app.bsky.feed.getPostThread'
import * as bskyGetFeed from './app.bsky.feed.getFeed'
import * as bskyRegisterPush from './app.bsky.notification.registerPush'
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
import * as ozoneGetAccountTimeline from './tools.ozone.moderation.getAccountTimeline'
import * as ozoneSearchRepos from './tools.ozone.moderation.searchRepos'
import * as ozoneGetReporterStats from './tools.ozone.moderation.getReporterStats'
import * as ozoneGetRepos from './tools.ozone.moderation.getRepos'
import * as ozoneGetRecords from './tools.ozone.moderation.getRecords'
import * as ozoneGetSubjects from './tools.ozone.moderation.getSubjects'
import * as ozoneScheduleAction from './tools.ozone.moderation.scheduleAction'
import * as ozoneListScheduledActions from './tools.ozone.moderation.listScheduledActions'
import * as ozoneCancelScheduledActions from './tools.ozone.moderation.cancelScheduledActions'
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
import * as ozoneCommCreate from './tools.ozone.communication.createTemplate'
import * as ozoneCommUpdate from './tools.ozone.communication.updateTemplate'
import * as ozoneCommDelete from './tools.ozone.communication.deleteTemplate'
import * as ozoneCommList from './tools.ozone.communication.listTemplates'
import * as ozoneVerifyGrant from './tools.ozone.verification.grantVerifications'
import * as ozoneVerifyRevoke from './tools.ozone.verification.revokeVerifications'
import * as ozoneVerifyList from './tools.ozone.verification.listVerifications'
import * as ozoneSigSearch from './tools.ozone.signature.searchAccounts'
import * as ozoneSigRelated from './tools.ozone.signature.findRelatedAccounts'
import * as ozoneSigCorr from './tools.ozone.signature.findCorrelation'
import * as ozoneSafelinkAdd from './tools.ozone.safelink.addRule'
import * as ozoneSafelinkUpdate from './tools.ozone.safelink.updateRule'
import * as ozoneSafelinkRemove from './tools.ozone.safelink.removeRule'
import * as ozoneSafelinkQueryRules from './tools.ozone.safelink.queryRules'
import * as ozoneSafelinkQueryEvents from './tools.ozone.safelink.queryEvents'
import * as ozoneServerGetConfig from './tools.ozone.server.getConfig'
import * as ozoneQueueCreate from './tools.ozone.queue.createQueue'
import * as ozoneQueueList from './tools.ozone.queue.listQueues'
import * as ozoneQueueUpdate from './tools.ozone.queue.updateQueue'
import * as ozoneQueueDelete from './tools.ozone.queue.deleteQueue'
import * as ozoneQueueAssign from './tools.ozone.queue.assignModerator'
import * as ozoneQueueUnassign from './tools.ozone.queue.unassignModerator'
import * as ozoneQueueGetAssignments from './tools.ozone.queue.getAssignments'
import * as ozoneQueueRoute from './tools.ozone.queue.routeReports'
import * as ozoneReportQuery from './tools.ozone.report.queryReports'
import * as ozoneReportGet from './tools.ozone.report.getReport'
import * as ozoneReportLatest from './tools.ozone.report.getLatestReport'
import * as ozoneReportListActs from './tools.ozone.report.listActivities'
import * as ozoneReportCreateAct from './tools.ozone.report.createActivity'
import * as ozoneReportAssign from './tools.ozone.report.assignModerator'
import * as ozoneReportUnassign from './tools.ozone.report.unassignModerator'
import * as ozoneReportReassign from './tools.ozone.report.reassignQueue'
import * as ozoneReportGetAssigns from './tools.ozone.report.getAssignments'
import * as ozoneReportLive from './tools.ozone.report.getLiveStats'
import * as ozoneReportHist from './tools.ozone.report.getHistoricalStats'
import * as ozoneReportRefresh from './tools.ozone.report.refreshStats'
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
  .register(tempFetchLabels.nsid, tempFetchLabels.def)
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
  .register(bskyGetProfile.nsid, bskyGetProfile.def)
  .register(bskyGetProfiles.nsid, bskyGetProfiles.def)
  .register(bskyGetAuthorFeed.nsid, bskyGetAuthorFeed.def)
  .register(bskyGetTimeline.nsid, bskyGetTimeline.def)
  .register(bskyGetActorLikes.nsid, bskyGetActorLikes.def)
  .register(bskyGetPostThread.nsid, bskyGetPostThread.def)
  .register(bskyGetFeed.nsid, bskyGetFeed.def)
  .register(bskyRegisterPush.nsid, bskyRegisterPush.def)
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
  .register(ozoneGetAccountTimeline.nsid, ozoneGetAccountTimeline.def)
  .register(ozoneSearchRepos.nsid, ozoneSearchRepos.def)
  .register(ozoneGetReporterStats.nsid, ozoneGetReporterStats.def)
  .register(ozoneGetRepos.nsid, ozoneGetRepos.def)
  .register(ozoneGetRecords.nsid, ozoneGetRecords.def)
  .register(ozoneGetSubjects.nsid, ozoneGetSubjects.def)
  .register(ozoneScheduleAction.nsid, ozoneScheduleAction.def)
  .register(ozoneListScheduledActions.nsid, ozoneListScheduledActions.def)
  .register(ozoneCancelScheduledActions.nsid, ozoneCancelScheduledActions.def)
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
  .register(ozoneCommCreate.nsid, ozoneCommCreate.def)
  .register(ozoneCommUpdate.nsid, ozoneCommUpdate.def)
  .register(ozoneCommDelete.nsid, ozoneCommDelete.def)
  .register(ozoneCommList.nsid, ozoneCommList.def)
  .register(ozoneVerifyGrant.nsid, ozoneVerifyGrant.def)
  .register(ozoneVerifyRevoke.nsid, ozoneVerifyRevoke.def)
  .register(ozoneVerifyList.nsid, ozoneVerifyList.def)
  .register(ozoneSigSearch.nsid, ozoneSigSearch.def)
  .register(ozoneSigRelated.nsid, ozoneSigRelated.def)
  .register(ozoneSigCorr.nsid, ozoneSigCorr.def)
  .register(ozoneSafelinkAdd.nsid, ozoneSafelinkAdd.def)
  .register(ozoneSafelinkUpdate.nsid, ozoneSafelinkUpdate.def)
  .register(ozoneSafelinkRemove.nsid, ozoneSafelinkRemove.def)
  .register(ozoneSafelinkQueryRules.nsid, ozoneSafelinkQueryRules.def)
  .register(ozoneSafelinkQueryEvents.nsid, ozoneSafelinkQueryEvents.def)
  .register(ozoneServerGetConfig.nsid, ozoneServerGetConfig.def)
  .register(ozoneQueueCreate.nsid, ozoneQueueCreate.def)
  .register(ozoneQueueList.nsid, ozoneQueueList.def)
  .register(ozoneQueueUpdate.nsid, ozoneQueueUpdate.def)
  .register(ozoneQueueDelete.nsid, ozoneQueueDelete.def)
  .register(ozoneQueueAssign.nsid, ozoneQueueAssign.def)
  .register(ozoneQueueUnassign.nsid, ozoneQueueUnassign.def)
  .register(ozoneQueueGetAssignments.nsid, ozoneQueueGetAssignments.def)
  .register(ozoneQueueRoute.nsid, ozoneQueueRoute.def)
  .register(ozoneReportQuery.nsid, ozoneReportQuery.def)
  .register(ozoneReportGet.nsid, ozoneReportGet.def)
  .register(ozoneReportLatest.nsid, ozoneReportLatest.def)
  .register(ozoneReportListActs.nsid, ozoneReportListActs.def)
  .register(ozoneReportCreateAct.nsid, ozoneReportCreateAct.def)
  .register(ozoneReportAssign.nsid, ozoneReportAssign.def)
  .register(ozoneReportUnassign.nsid, ozoneReportUnassign.def)
  .register(ozoneReportReassign.nsid, ozoneReportReassign.def)
  .register(ozoneReportGetAssigns.nsid, ozoneReportGetAssigns.def)
  .register(ozoneReportLive.nsid, ozoneReportLive.def)
  .register(ozoneReportHist.nsid, ozoneReportHist.def)
  .register(ozoneReportRefresh.nsid, ozoneReportRefresh.def)
