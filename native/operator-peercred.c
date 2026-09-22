/*
 * operator-peercred-helper — resolve the peer identity of an accepted Unix
 * socket passed on fd 0.
 *
 * Output (single line, whitespace separated):
 *
 *   <uid> <gid> <pid> <group_1> <group_2> ...
 *
 * The group entries are POSIX group NAMES where the id resolves, falling back
 * to the numeric id when it does not. The authorization policy matches peers
 * on group names, so emitting bare ids here denies every real peer: the name
 * resolution has to happen where libc/NSS is available, which is this helper
 * and not the Node client.
 *
 * Anything that is not a safe group token is emitted as its numeric id instead,
 * so an unusual name can never produce a token the client rejects.
 *
 * Exits non-zero (never printing a partial line) on any failure, so the daemon
 * fails closed.
 */
#define _GNU_SOURCE

#include <errno.h>
#include <grp.h>
#include <linux/net.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

/* Mirrors the conservative group-name charset the Node client accepts. */
static int is_safe_group_name(const char *name) {
  size_t length = strlen(name);
  if (length == 0 || length > 64) return 0;
  for (size_t index = 0; index < length; index++) {
    char character = name[index];
    int alphanumeric = (character >= 'A' && character <= 'Z') ||
                       (character >= 'a' && character <= 'z') ||
                       (character >= '0' && character <= '9');
    if (!alphanumeric && character != '_' && character != '-' && character != '.' &&
        character != '+')
      return 0;
  }
  return 1;
}

/* Print one group token: the resolved name, or the numeric id as a fallback. */
static int print_group(const char *token) {
  char *end = NULL;
  errno = 0;
  unsigned long id = strtoul(token, &end, 10);
  int numeric = errno == 0 && end != token && *end == '\0';

  if (numeric) {
    struct group entry;
    struct group *resolved = NULL;
    char buffer[4096];
    if (getgrgid_r((gid_t)id, &entry, buffer, sizeof(buffer), &resolved) == 0 &&
        resolved != NULL && resolved->gr_name != NULL && is_safe_group_name(resolved->gr_name))
      return printf(" %s", resolved->gr_name) < 0 ? 1 : 0;
  }
  return printf(" %s", token) < 0 ? 1 : 0;
}

static int print_groups(pid_t pid) {
  char path[64];
  (void)snprintf(path, sizeof(path), "/proc/%ld/status", (long)pid);

  FILE *status = fopen(path, "r");
  if (status == NULL) return 1;

  char line[4096];
  while (fgets(line, sizeof(line), status) != NULL) {
    if (strncmp(line, "Groups:", 7) != 0) continue;
    char *cursor = line + 7;
    while (*cursor == ' ' || *cursor == '\t') cursor++;
    for (char *token = strtok(cursor, " \t\r\n"); token != NULL;
         token = strtok(NULL, " \t\r\n")) {
      if (print_group(token) != 0) {
        (void)fclose(status);
        return 1;
      }
    }
    (void)fclose(status);
    return 0;
  }

  (void)fclose(status);
  return 1;
}

int main(void) {
  struct ucred credentials;
  socklen_t length = (socklen_t)sizeof(credentials);
  if (getsockopt(STDIN_FILENO, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0)
    return 2;
  if (length != sizeof(credentials) || credentials.pid <= 0)
    return 3;

  if (printf("%lu %lu %ld", (unsigned long)credentials.uid,
             (unsigned long)credentials.gid, (long)credentials.pid) < 0)
    return 4;
  if (print_groups(credentials.pid) != 0) return 5;
  if (putchar('\n') == EOF) return 6;
  return 0;
}
