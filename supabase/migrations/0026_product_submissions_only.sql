-- Stop new legacy idea submissions without changing historical rows or links.
-- RESTRICTIVE composes with existing author, pending-status and blacklist policies.
create policy "submission insert must be product"
  on public.submissions as restrictive for insert to authenticated
  with check (type = 'product');

-- Rollback: drop policy "submission insert must be product" on public.submissions;
notify pgrst, 'reload schema';
