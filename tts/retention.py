"""Delete expired, archived, and orphaned audio through the Storage API."""
import logging
import re

LOG = logging.getLogger('stash.audio')
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'


def cleanup_expired_audio(api):
    """Validate the entire batch before deleting exact, unreferenced paths.

    The service-only database collector checks references and object versions.
    Deletions are durable and replacements use different UUIDs. Never back up.
    """
    pending = api.rpc('collect_stash_audio_cleanup', p_user_id=api.user)
    groups = {}
    for row in pending:
        bucket = row['bucket_name']
        pattern = {'stash-audio': re.escape(api.user) + '/' + UUID + r'\.mp3',
                   'audio': UUID + r'\.mp3'}.get(bucket)
        if not pattern or not re.fullmatch(pattern, row['object_name']):
            raise RuntimeError('Cleanup received an unexpected object path; nothing was deleted')
        groups.setdefault(bucket, []).append(row)
    removed = 0
    for bucket, rows in groups.items():
        api.heartbeat()
        api.call('/storage/v1/object/' + bucket,
                 {'prefixes': [row['object_name'] for row in rows]}, method='DELETE', timeout=120)
        removed += api.rpc('ack_stash_audio_deletions', p_user_id=api.user,
                           p_ids=[row['id'] for row in rows])
    if removed:
        LOG.info('Audio cleanup removed %s recordings', removed)
    return removed
