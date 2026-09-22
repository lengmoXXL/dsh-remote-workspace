//! The control channel one program host inherits from its spawner.
//!
//! The DeepSeek Harness PTC process protocol is a byte stream of
//! length-prefixed JSON frames: a big-endian `u32` byte count followed by that
//! many UTF-8 bytes. The host provider (`dsh-ptc-runtime-node`) writes the boot
//! payload first and answers binding calls on the same stream, so this side only
//! has to frame and unframe.
//!
//! The descriptor is fixed by the subprocess seam, which duplicates the control
//! socketpair onto descriptor 7 before exec.
//!
//! @module dsh-ptc-host/channel

use std::fs::File;
use std::io::Error;
use std::io::ErrorKind;
use std::io::Read;
use std::io::Result;
use std::io::Write;
use std::os::fd::FromRawFd;

/// The descriptor the subprocess seam publishes the control socketpair on.
pub const CONTROL_DESCRIPTOR: i32 = 7;

/// One framed JSON byte stream, owned by this process.
pub struct Channel {
    file: File,
    /// The host's own frame limit, from argv.
    max_frame: usize,
}

impl Channel {
    pub fn inherit(max_frame: usize) -> Result<Self> {
        // The limit is validated here rather than at every write, because argv
        // is the one place it enters the process and a frame longer than its
        // length prefix can describe is not a write this side has to survive.
        if max_frame > u32::MAX as usize {
            return Err(Error::new(
                ErrorKind::InvalidInput,
                format!("the frame limit {max_frame} does not fit an unsigned 32-bit length"),
            ));
        }
        // SAFETY: the seam duplicates the control socketpair onto this
        // descriptor before exec, and nothing else in this process owns it.
        let file = unsafe { File::from_raw_fd(CONTROL_DESCRIPTOR) };
        Ok(Self { file, max_frame })
    }

    pub fn write_frame(&mut self, payload: &[u8]) -> Result<()> {
        if payload.is_empty() || payload.len() > self.max_frame {
            return Err(Error::new(
                ErrorKind::InvalidInput,
                format!(
                    "a control frame of {} bytes is empty or exceeds the {}-byte limit",
                    payload.len(),
                    self.max_frame,
                ),
            ));
        }
        let length = u32::try_from(payload.len())
            .expect("the inherited frame limit fits an unsigned 32-bit length");
        self.file.write_all(&length.to_be_bytes())?;
        self.file.write_all(payload)?;
        self.file.flush()
    }

    /// Read one frame, or `None` once the peer closed the channel.
    pub fn read_frame(&mut self) -> Result<Option<Vec<u8>>> {
        let mut header = [0u8; 4];
        match self.file.read_exact(&mut header) {
            // A peer that closed mid-header is the channel ending, not a frame
            // this side can report a length for.
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
            Err(error) => return Err(error),
            Ok(()) => {}
        }
        let length = u32::from_be_bytes(header) as usize;
        if length == 0 || length > self.max_frame {
            return Err(Error::new(
                ErrorKind::InvalidData,
                format!(
                    "an incoming control frame of {} bytes is empty or exceeds the {}-byte limit",
                    length, self.max_frame,
                ),
            ));
        }
        let mut payload = vec![0u8; length];
        match self.file.read_exact(&mut payload) {
            Ok(()) => Ok(Some(payload)),
            // A frame cut in half by a closing peer is the channel ending, not
            // a distinct failure the program could act on.
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => Ok(None),
            Err(error) => Err(error),
        }
    }
}
