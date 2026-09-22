`chrome-seccomp.json` is adapted from Playwright v1.59.1:
https://github.com/microsoft/playwright/blob/v1.59.1/utils/docker/seccomp_profile.json

Copyright Microsoft Corporation. Licensed under Apache-2.0:
https://github.com/microsoft/playwright/blob/v1.59.1/LICENSE

This is Docker's syscall allowlist with the namespace operations required by
Chrome's sandbox. It applies only to this task's container. The container does
not use privileged mode, host IPC, or an unsandboxed browser.

The additional unconditional `chroot` allow rule lets Chrome isolate itself
inside its own user namespace when the container drops all capabilities.
The kernel still requires the namespace's capability for that syscall; no
container capabilities are added. Upstream's capability-conditional rule is
omitted by Docker when `cap_drop: ALL` is used, blocking Chrome's sandbox setup.
