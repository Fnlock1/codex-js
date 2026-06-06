export const APPROVAL_POLICIES = Object.freeze({
  UNTRUSTED: "untrusted",
  ON_REQUEST: "on-request",
  ON_FAILURE: "on-failure",
  NEVER: "never"
});

export const SANDBOX_MODES = Object.freeze({
  READ_ONLY: "read-only",
  WORKSPACE_WRITE: "workspace-write",
  DANGER_FULL_ACCESS: "danger-full-access"
});

export const PERMISSION_PROFILES = Object.freeze({
  READ_ONLY: {
    approvalPolicy: APPROVAL_POLICIES.ON_REQUEST,
    sandboxMode: SANDBOX_MODES.READ_ONLY
  },
  WORKSPACE_WRITE: {
    approvalPolicy: APPROVAL_POLICIES.ON_REQUEST,
    sandboxMode: SANDBOX_MODES.WORKSPACE_WRITE
  },
  DANGER_FULL_ACCESS: {
    approvalPolicy: APPROVAL_POLICIES.NEVER,
    sandboxMode: SANDBOX_MODES.DANGER_FULL_ACCESS
  }
});
