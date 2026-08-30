# Isolate product authentication from Webmail

Same Page will self-host Better Auth on its Worker and D1, and send email OTP messages directly through Resend using a dedicated sending subdomain and a separate domain-restricted Sending-only key. It will reuse the existing `clyapps.com` mail-provider foundation but will not call the fixed-user Webmail API, share its secret, or write authentication messages into its Sent mailbox; this preserves the Webmail security boundary while keeping low-volume authentication within the free service tiers.
