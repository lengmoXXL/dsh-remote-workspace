/**
 * Bilingual copy for the Remote workspaces settings section.
 *
 * The Chinese dictionary is the key source; the English one is checked against
 * its key set, so a key added to one without the other fails the build. The
 * section receives `t` through the standard locale seat, which the shell
 * derives from the namespace registered in {@link NS}.
 *
 * @module dsh-remote-workspace/plugin/client/locales
 */

/** Locale namespace owned by this plugin's Web UI. */
export const NS = 'dsh-remote-workspace'

/** Simplified Chinese dictionary and key source. */
export const zh = {
  title: '远程工作区',
  subtitle:
    '管理可以访问的机器、机器上的目录，以及从 git 仓库切出的 worktree。'
    + '切出的 worktree 会成为一个本地工作区，其文件与命令都在那台机器上执行。',
  refresh: '刷新',
  actions: '操作',
  addMachine: '添加机器',
  loading: '正在加载…',
  machinesEmpty: '还没有配置机器。添加一台机器后，就能浏览它的仓库并切出 worktree。',
  repositoriesEmpty: '这台机器上还没有登记仓库。',
  worktreesEmpty: '这个仓库还没有 worktree。',

  'status.ready': '已连接',
  'status.local': '始终可用',
  'status.connecting': '连接中',
  'progress.checking': '检查远端环境…',
  'progress.reusing': '复用已在运行的 agent {version}',
  'progress.fetching': '获取 agent {version}…',
  'progress.cached': '使用本地缓存的 agent {version}',
  'progress.downloading': '下载 {asset}…',
  'progress.uploading': '上传 agent 到机器…',
  'progress.starting': '启动 agent…',
  'status.idle': '未连接',
  'status.failed': '连接失败',
  'status.disconnected': '已断开',

  connect: '连接',
  disconnect: '断开',
  removeMachine: '移除机器',
  addRepository: '添加仓库',
  forgetRepository: '移除仓库',
  newWorktree: '新建 worktree',
  openWorktree: '打开工作区',
  closeWorktree: '关闭工作区',
  removeWorktree: '移除',
  releaseWorktree: '关闭 worktree',

  fieldTarget: 'SSH 目标',
  fieldSshPort: 'SSH 端口',
  fieldIdentityFile: '私钥文件',
  fieldToken: '访问令牌',
  fieldName: '显示名称',
  fieldRepository: '仓库目录',
  fieldWorktreeName: 'worktree 名称',
  fieldWorktreePath: '检出目录',
  placeholderTarget: 'user@build-01',
  placeholderIdentityFile: '~/.ssh/id_ed25519',
  placeholderRepoPath: '/workspace/project',
  placeholderWorktreeName: 'feature-x',
  hintTarget: 'user@主机，或 ~/.ssh/config 里的别名。使用本机 ssh 的密钥与 ssh-agent，不会交互提示密码。',
  hintSshPort: '留空则沿用 ssh 自己的配置。',
  hintIdentityFile: '留空则沿用 ssh 的配置与 agent。',
  forwarding: '隧道 127.0.0.1:{port}',
  hintToken: '插件安装并启动远端 agent 时使用的访问令牌。',
  hintRepository: '该机器上的绝对路径。普通目录也可以登记；在机器上 git init 之后就能从它切出 worktree。',
  hintWorktreeName: '分支名会变成 worktree/<名称>，名称不可重复。',
  hintWorktreePath: '已按默认路径填好（检出根目录下的 <仓库>/<名称>），可以改成这台机器上的任意绝对路径；目录不能已存在。',
  optional: '可选',

  pickerEmpty: '这个目录下没有子目录。',
  pickerNoMatch: '没有匹配的子目录。',
  pickerUp: '上一层',
  pickerUse: '使用这个目录',

  requestFailed: '请求失败（{status}）',
  create: '创建',
  cancel: '取消',
  close: '关闭',
  remove: '移除',

  removeMachineTitle: '移除机器？',
  removeMachineBody: '这台机器的仓库登记会一起删除，机器上的 worktree 与分支不受影响。',
  removeRepositoryTitle: '移除仓库登记？',
  removeRepositoryBody: '只会删除本地登记，并关闭它的目录工作区；机器上的文件和 worktree 都不受影响。',
  notARepository: '还不是 git 仓库',
  removeWorktreeTitle: '移除 worktree？',
  removeWorktreeBody: '会删除机器上的检出目录；勾选后分支也会被删除。未提交的改动会一并丢弃。',
  removeAdoptedWorktreeBody: '这个检出不是插件切出来的，机器上可能还有别人的活儿；删除会把它整个删掉，未提交的改动会一并丢弃。',
  removeWorktreeBranch: '同时删除分支',
  releaseWorktreeTitle: '关闭这个 worktree？',
  releaseWorktreeBody: '只会移除插件里的这条记录并关闭它的工作区；机器上的检出原样保留。',
  noToken: '未设置令牌',
} satisfies Record<string, string>

/** Locale key union this section may translate. */
export type RemoteWorktreesKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  title: 'Remote workspaces',
  subtitle:
    'Manage the machines this deployment can reach, the directories on them, '
    + 'and the worktrees cut from the git repositories among them. A worktree '
    + 'becomes a local workspace whose file and shell tools run on that machine.',
  refresh: 'Refresh',
  actions: 'Actions',
  addMachine: 'Add machine',
  loading: 'Loading…',
  machinesEmpty: 'No machines yet. Add one to browse its repositories and cut worktrees from them.',
  repositoriesEmpty: 'No repositories registered on this machine yet.',
  worktreesEmpty: 'No worktrees in this repository yet.',

  'status.ready': 'Connected',
  'status.local': 'always available',
  'status.connecting': 'Connecting',
  'progress.checking': 'Checking the machine…',
  'progress.reusing': 'Reusing the running agent {version}',
  'progress.fetching': 'Fetching agent {version}…',
  'progress.cached': 'Using the cached agent {version}',
  'progress.downloading': 'Downloading {asset}…',
  'progress.uploading': 'Uploading the agent…',
  'progress.starting': 'Starting the agent…',
  'status.idle': 'Disconnected',
  'status.failed': 'Connection failed',
  'status.disconnected': 'Disconnected',

  connect: 'Connect',
  disconnect: 'Disconnect',
  removeMachine: 'Remove machine',
  addRepository: 'Add repository',
  forgetRepository: 'Forget repository',
  newWorktree: 'New worktree',
  openWorktree: 'Open workspace',
  closeWorktree: 'Close workspace',
  removeWorktree: 'Remove',
  releaseWorktree: 'Close worktree',

  fieldTarget: 'SSH destination',
  fieldSshPort: 'SSH port',
  fieldIdentityFile: 'Identity file',
  fieldToken: 'Access token',
  fieldName: 'Display name',
  fieldRepository: 'Repository directory',
  fieldWorktreeName: 'Worktree name',
  fieldWorktreePath: 'Checkout directory',
  placeholderTarget: 'user@build-01',
  placeholderIdentityFile: '~/.ssh/id_ed25519',
  placeholderRepoPath: '/workspace/project',
  placeholderWorktreeName: 'feature-x',
  hintTarget: 'user@host, or an alias from ~/.ssh/config. Uses your local ssh keys and agent; a password is never prompted for.',
  hintSshPort: 'Leave blank to use your ssh configuration.',
  hintIdentityFile: 'Leave blank to use your ssh configuration and agent.',
  forwarding: 'tunnel 127.0.0.1:{port}',
  hintToken: 'The token the plugin gives the remote agent it installs and starts.',
  hintRepository: 'An absolute path on that machine. A plain directory is fine too; once it is a git repository there, worktrees can be cut from it.',
  hintWorktreeName: 'The branch becomes worktree/<name>; the name must be unique.',
  hintWorktreePath: 'Filled in with the default — the checkout root plus <repository>/<name> — and editable to any absolute path on that machine; the directory must not exist yet.',
  optional: 'optional',

  pickerEmpty: 'No subdirectories here.',
  pickerNoMatch: 'No subdirectories match.',
  pickerUp: 'Parent directory',
  pickerUse: 'Use this directory',

  requestFailed: 'Request failed with {status}',
  create: 'Create',
  cancel: 'Cancel',
  close: 'Close',
  remove: 'Remove',

  removeMachineTitle: 'Remove this machine?',
  removeMachineBody: 'Its repository registrations are dropped too. Worktrees and branches on the machine are untouched.',
  removeRepositoryTitle: 'Forget this repository?',
  removeRepositoryBody: 'Only the local registration is dropped, and the workspace of the directory itself is closed with it; files and worktrees on the machine are untouched.',
  notARepository: 'Not a git repository yet',
  removeWorktreeTitle: 'Remove this worktree?',
  removeWorktreeBody: 'The checkout is deleted on the machine; tick the option to delete its branch too. Uncommitted changes are discarded.',
  removeAdoptedWorktreeBody: 'This checkout is not one the plugin cut, and the machine may hold someone\'s work in it; removing deletes the whole directory, and uncommitted changes go with it.',
  removeWorktreeBranch: 'Also delete its branch',
  releaseWorktreeTitle: 'Close this worktree?',
  releaseWorktreeBody: 'Only the plugin\'s record goes, and its workspace is closed with it; the checkout on the machine stays where it is.',
  noToken: 'no token',
} satisfies Record<RemoteWorktreesKey, string>
