# Report loading and caching

The base `/api/sites/:id` route reads the generated performance report without waiting for Google. The browser loads `/api/sites/:id/analytics` separately and displays independent loading/retry states. Request identifiers and cancellation prevent a late site/date-range response from overwriting the current selection.

Analytics and Search Console save successful responses to local cache files. Exact site/property, page, and range keys isolate data; simultaneous requests for one key share one upstream call. Cached reports appear immediately while a refresh runs. A failed refresh keeps the last successful response and reports its timestamp. Failed keys back off for 30 seconds. Analytics stays fresh for 10 minutes, Search Console for two minutes, and saved reports expire after seven days.

GA core traffic metrics remain available if its optional detail group fails. Search Console preserves available sections if optional dimensions fail. Missing sections are labelled as delayed, and missing numeric values are not converted to zeros. A partial response does not replace a complete cached report. Search exports refuse to produce misleading page comparisons when the required page sections are missing.

Google requests use one retry with a 10-second request timeout; browser analytics requests stop after 35 seconds and offer retry. Google API and token requests share reusable connections and auth clients. Direct connections use IPv4 by default, following the successful IPv4 connectivity check on this machine; set `GOOGLE_API_IP_FAMILY=auto` or `6` to override. Configured HTTP(S) proxies keep the Google library's proxy handling. TLS verification stays enabled. Authentication and upstream connection delays can still occur. A first request without a cache needs a working Google connection; caching cannot create missing live data.

`DASHBOARD_CACHE_DIR` can select a cache directory. Local disk storage persists across local restarts. On Vercel with `BLOB_READ_WRITE_TOKEN`, each Google cache key is also saved in Private Blob storage and read by new instances. Temporary instance files remain an additional cache layer. Independent Vercel instances still need a shared attempt limiter for login.

Browser reliability tests use isolated credentials, stubbed upstream APIs, and a temporary cache directory. They produce `temp-file/dashboard-refined-desktop.png` and `temp-file/dashboard-refined-mobile.png` with test analytics. They do not overwrite live report caches or contact Google.
