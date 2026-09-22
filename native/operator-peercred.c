/*
 * operator-peercred-helper — resolve the peer identity of an accepted Unix
 * socket passed on fd 0.
 *
 * Output (single line, whitespace separated):
 *
 *   <uid> <gid> <pid> <group_1> <group_2> ...
 *
 * The group entries are POSIX group NAMES from the local /etc/group file,
 * falling back to the numeric id when it does not have a local name. The
 * authorization policy matches peers on group names, so the name resolution
 * has to happen where the local group database is available: this helper,
 * not the Node client.
 *
 * This helper deliberately uses only Linux syscalls and small local parsers.
 * It must be fully static without pulling glibc NSS, locale, or gconv data
 * into the binary; those static data paths point into the build host's
 * /nix/store and are not valid on a portable target.
 *
 * Anything that is not a safe group token is emitted as its numeric id instead,
 * so an unusual name can never produce a token the client rejects.
 *
 * Exits non-zero (never printing a partial line) on any failure, so the daemon
 * fails closed.
 */

#define SYS_read 0
#define SYS_write 1
#define SYS_close 3
#define SYS_openat 257
#define SYS_getsockopt 55
#define SYS_exit 60

#define AT_FDCWD (-100)
#define O_RDONLY 0
#define SOL_SOCKET 1
#define SO_PEERCRED 17

typedef unsigned long usize;
typedef long ssize;

typedef struct {
  int pid;
  unsigned int uid;
  unsigned int gid;
} peer_credentials;

static inline long syscall3(long number, long arg1, long arg2, long arg3) {
  long result;
  __asm__ volatile("syscall"
                   : "=a"(result)
                   : "a"(number), "D"(arg1), "S"(arg2), "d"(arg3)
                   : "rcx", "r11", "memory");
  return result;
}

static inline long syscall4(long number, long arg1, long arg2, long arg3, long arg4) {
  long result;
  register long fourth __asm__("r10") = arg4;
  __asm__ volatile("syscall"
                   : "=a"(result)
                   : "a"(number), "D"(arg1), "S"(arg2), "d"(arg3), "r"(fourth)
                   : "rcx", "r11", "memory");
  return result;
}

static inline long syscall5(
    long number, long arg1, long arg2, long arg3, long arg4, long arg5) {
  long result;
  register long fourth __asm__("r10") = arg4;
  register long fifth __asm__("r8") = arg5;
  __asm__ volatile("syscall"
                   : "=a"(result)
                   : "a"(number), "D"(arg1), "S"(arg2), "d"(arg3), "r"(fourth), "r"(fifth)
                   : "rcx", "r11", "memory");
  return result;
}

static inline void exit_process(int status) {
  (void)syscall3(SYS_exit, status, 0, 0);
  for (;;) {
  }
}

static usize string_length(const char *value) {
  usize length = 0;
  while (value[length] != '\0') length++;
  return length;
}

static int safe_group_name(const char *name, usize length) {
  if (length == 0 || length > 64) return 0;
  for (usize index = 0; index < length; index++) {
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

static int append_bytes(char *output, usize capacity, usize *length, const char *value, usize count) {
  if (*length > capacity || count > capacity - *length) return 0;
  for (usize index = 0; index < count; index++) output[*length + index] = value[index];
  *length += count;
  return 1;
}

static int append_char(char *output, usize capacity, usize *length, char value) {
  return append_bytes(output, capacity, length, &value, 1);
}

static int append_uint(char *output, usize capacity, usize *length, unsigned long value) {
  char digits[32];
  usize digit_count = 0;
  do {
    digits[digit_count++] = (char)('0' + (value % 10));
    value /= 10;
  } while (value != 0 && digit_count < sizeof(digits));
  if (value != 0) return 0;
  while (digit_count > 0) {
    digit_count--;
    if (!append_char(output, capacity, length, digits[digit_count])) return 0;
  }
  return 1;
}

static int parse_uint(const char *begin, const char *end, unsigned long *value) {
  if (begin == end) return 0;
  unsigned long parsed = 0;
  for (const char *cursor = begin; cursor != end; cursor++) {
    if (*cursor < '0' || *cursor > '9') return 0;
    unsigned long digit = (unsigned long)(*cursor - '0');
    if (parsed > (~0UL - digit) / 10UL) return 0;
    parsed = parsed * 10UL + digit;
  }
  *value = parsed;
  return 1;
}

static int read_file(const char *path, char *buffer, usize capacity, usize *length) {
  long descriptor = syscall4(SYS_openat, AT_FDCWD, (long)path, O_RDONLY, 0);
  if (descriptor < 0) return 0;
  usize used = 0;
  while (used < capacity) {
    long count = syscall3(SYS_read, descriptor, (long)(buffer + used), (long)(capacity - used));
    if (count < 0) {
      (void)syscall3(SYS_close, descriptor, 0, 0);
      return 0;
    }
    if (count == 0) {
      (void)syscall3(SYS_close, descriptor, 0, 0);
      *length = used;
      return 1;
    }
    used += (usize)count;
  }
  (void)syscall3(SYS_close, descriptor, 0, 0);
  return 0;
}

static int resolve_local_group_name(
    unsigned long id, char *group_file, usize group_file_length, char *name, usize capacity) {
  usize line_start = 0;
  while (line_start < group_file_length) {
    usize line_end = line_start;
    while (line_end < group_file_length && group_file[line_end] != '\n') line_end++;
    usize name_end = line_start;
    while (name_end < line_end && group_file[name_end] != ':') name_end++;
    if (name_end != line_start && name_end < line_end) {
      usize password_end = name_end + 1;
      while (password_end < line_end && group_file[password_end] != ':') password_end++;
      usize gid_start = password_end + 1;
      usize gid_end = gid_start;
      while (gid_end < line_end && group_file[gid_end] != ':') gid_end++;
      unsigned long resolved_id = 0;
      if (password_end < line_end && gid_end < line_end &&
          parse_uint(group_file + gid_start, group_file + gid_end, &resolved_id) &&
          resolved_id == id && safe_group_name(group_file + line_start, name_end - line_start) &&
          name_end - line_start < capacity) {
        for (usize index = 0; index < name_end - line_start; index++)
          name[index] = group_file[line_start + index];
        name[name_end - line_start] = '\0';
        return 1;
      }
    }
    line_start = line_end + 1;
  }
  return 0;
}

static int append_group_token(
    char *output,
    usize capacity,
    usize *length,
    const char *token_begin,
    const char *token_end,
    char *group_file,
    usize group_file_length) {
  unsigned long id = 0;
  char name[65];
  if (!append_char(output, capacity, length, ' ')) return 0;
  if (parse_uint(token_begin, token_end, &id) &&
      resolve_local_group_name(id, group_file, group_file_length, name, sizeof(name)))
    return append_bytes(output, capacity, length, name, string_length(name));
  return append_bytes(output, capacity, length, token_begin, (usize)(token_end - token_begin));
}

static int append_peer_groups(
    char *output, usize capacity, usize *length, int pid, char *group_file, usize group_file_length) {
  char path[64] = "/proc/";
  usize path_length = string_length(path);
  if (!append_uint(path, sizeof(path), &path_length, (unsigned long)pid) ||
      !append_bytes(path, sizeof(path), &path_length, "/status", 7))
    return 0;
  path[path_length] = '\0';

  char status[8192];
  usize status_length = 0;
  if (!read_file(path, status, sizeof(status), &status_length)) return 0;

  usize line_start = 0;
  while (line_start < status_length) {
    usize line_end = line_start;
    while (line_end < status_length && status[line_end] != '\n') line_end++;
    if (line_end - line_start >= 7 && status[line_start] == 'G' && status[line_start + 1] == 'r' &&
        status[line_start + 2] == 'o' && status[line_start + 3] == 'u' &&
        status[line_start + 4] == 'p' && status[line_start + 5] == 's' &&
        status[line_start + 6] == ':') {
      usize cursor = line_start + 7;
      while (cursor < line_end && (status[cursor] == ' ' || status[cursor] == '\t')) cursor++;
      usize group_count = 0;
      while (cursor < line_end) {
        usize token_end = cursor;
        while (token_end < line_end && status[token_end] != ' ' && status[token_end] != '\t') token_end++;
        if (token_end > cursor) {
          if (!append_group_token(
                  output, capacity, length, status + cursor, status + token_end, group_file,
                  group_file_length))
            return 0;
          group_count++;
        }
        cursor = token_end;
        while (cursor < line_end && (status[cursor] == ' ' || status[cursor] == '\t')) cursor++;
      }
      return group_count > 0;
    }
    line_start = line_end + 1;
  }
  return 0;
}

static int write_all(const char *value, usize length) {
  usize offset = 0;
  while (offset < length) {
    long count = syscall3(SYS_write, 1, (long)(value + offset), (long)(length - offset));
    if (count <= 0) return 0;
    offset += (usize)count;
  }
  return 1;
}

void _start(void) {
  peer_credentials credentials;
  unsigned int credentials_length = (unsigned int)sizeof(credentials);
  long socket_result = syscall5(
      SYS_getsockopt,
      0,
      SOL_SOCKET,
      SO_PEERCRED,
      (long)&credentials,
      (long)&credentials_length);
  if (socket_result < 0 || credentials_length != sizeof(credentials) || credentials.pid <= 0)
    exit_process(2);

  char group_file[131072];
  usize group_file_length = 0;
  if (!read_file("/etc/group", group_file, sizeof(group_file), &group_file_length)) exit_process(3);

  char output[8192];
  usize output_length = 0;
  if (!append_uint(output, sizeof(output), &output_length, (unsigned long)credentials.uid) ||
      !append_char(output, sizeof(output), &output_length, ' ') ||
      !append_uint(output, sizeof(output), &output_length, (unsigned long)credentials.gid) ||
      !append_char(output, sizeof(output), &output_length, ' ') ||
      !append_uint(output, sizeof(output), &output_length, (unsigned long)credentials.pid) ||
      !append_peer_groups(
          output, sizeof(output), &output_length, credentials.pid, group_file, group_file_length) ||
      !append_char(output, sizeof(output), &output_length, '\n') || !write_all(output, output_length))
    exit_process(4);
  exit_process(0);
}
