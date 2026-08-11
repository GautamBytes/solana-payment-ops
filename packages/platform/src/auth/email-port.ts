export type AuthEmailKind =
  | "bootstrap_owner"
  | "email_verification"
  | "password_reset"
  | "organization_invitation";

export interface AuthEmail {
  readonly kind: AuthEmailKind;
  readonly to: string;
  readonly actionUrl: string;
  readonly expiresAt?: Date;
  readonly organizationName?: string;
}

export interface EmailDeliveryPort {
  send(message: AuthEmail): Promise<void>;
}
