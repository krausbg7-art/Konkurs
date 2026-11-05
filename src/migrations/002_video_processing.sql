-- Uploaded videos are transcoded in the background before moderation:
-- processing → pending (ready for the organiser) or failed.
alter table videos drop constraint videos_status_check;
alter table videos add constraint videos_status_check
  check (status in ('processing', 'pending', 'approved', 'rejected', 'replaced', 'failed'));
alter table videos add column processing_error text;
alter table videos add column processed_at timestamptz;

-- One video in flight per company: either being processed or waiting for moderation.
drop index videos_one_pending;
create unique index videos_one_active on videos (company_id) where status in ('processing', 'pending');
