export const UPDATE = Object.freeze({
  bundleId: 'com.aloqa.call-bots',
  feedUrl:
    'https://raw.githubusercontent.com/tbm-org/call-bots/codex/updates/appcast.xml',
  feedBranch: 'codex/updates',
  githubRepo: 'tbm-org/call-bots',
  keychainAccount: 'com.aloqa.call-bots',
  publicEdKey: 'JbqCiFtuDZTnMqUmn+opKe0otL1pUARNMrIKmUELCFk=',
  scheduledCheckInterval: 86_400,
  sparkleVersion: '2.9.6',
  sparkleSha256: '52bf9e88cdd972fc0c81501377a880e90d47031bd8ca5462488f843e2609e192',
})

export const sparkleDownloadUrl = () =>
  `https://github.com/sparkle-project/Sparkle/releases/download/${UPDATE.sparkleVersion}/Sparkle-${UPDATE.sparkleVersion}.tar.xz`
