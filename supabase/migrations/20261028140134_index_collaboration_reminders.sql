create index keyon_collab_history_reference on public.keyon_collaboration_history(collaboration_id,user_id);
create index keyon_collab_reminder_reference on public.keyon_collaboration_reminders(collaboration_id,user_id);
create index keyon_collab_reminder_daily on public.keyon_collaboration_reminders(leased_at,user_id) where leased_at is not null;
create policy collab_mail_service_only on keyon_collab_private.mail_settings for all to service_role using(true) with check(true);
