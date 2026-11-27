-- The personal data consent and the acceptance of the contest rules are separate
-- checkboxes now; each gets its own timestamp. A captain also confirms rights to every video.
alter table accounts add column rules_accepted_at timestamptz;
alter table videos add column rights_confirmed_at timestamptz;
