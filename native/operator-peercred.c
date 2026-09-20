#define _GNU_SOURCE

#include <errno.h>
#include <linux/net.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

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
      if (printf(" %s", token) < 0) {
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
