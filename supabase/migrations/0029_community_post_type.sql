-- Apply and commit before 0030 uses the new enum value.
alter type public.submission_type add value if not exists 'post';
