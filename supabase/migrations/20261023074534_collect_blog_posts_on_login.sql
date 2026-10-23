-- Blog RSS is requested on login/site access and on opening the analysis view.
-- Keep the pending-work dispatcher active so requested jobs finish after the site closes.
select cron.alter_job(job_id := jobid, active := false)
from cron.job where jobname = 'keychallenge-blog-daily';
