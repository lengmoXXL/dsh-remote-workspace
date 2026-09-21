//! The control channel one program host inherits from its spawner.
//!
//! The DeepSeek Harness PTC process protocol is a byte stream of
//! length-prefixed JSON frames: a big-endian `u32` byte count followed by that
//! many UTF-8 bytes. The host provider (`dsh-ptc-runtime-node`) writes the boot
//! payload first and answers binding calls on the same stream, so this side only
//! has to frame and unframe.
//!
//! The descriptor is fixed by the subprocess seam: it duplicates the control
//! socketpair onto fd 7 and marks the child's environment, exactly as the Node
//! bootstrap expects.
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

/// The length prefix of one frame, in bytes.
const PREFIX_BYTES: usize = 4;

/// One framed JSON byte stream, owned by this process.
pub struct Channel {
    /// The inherited endpoint. One descriptor serves both directions.
    file: File,
    /// Largest frame either side may send, from the host's own validated limit.
    max_frame: usize,
}

impl Channel {
    /**
     * Adopt the inherited control descriptor.
     * @param max_frame - the frame and queued-write limit the host passed in argv.
     * @returns the channel, or the failure to adopt the descriptor.
     */
    pub fn inherit(max_frame: usize) -> Result<Self> {
        // SAFETY: the seam duplicates the control socketpair onto this
        // descriptor before exec, and nothing else in this process owns it.
        let file = unsafe { File::from_raw_fd(CONTROL_DESCRIPTOR) };
        Ok(Self { file, max_frame })
    }

    /// Write one complete frame.
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
        let length = u32::try_from(payload.len()).map_err(|_| {
            Error::new(
                ErrorKind::InvalidInput,
                format!(
                    "a control frame of {} bytes does not fit its length prefix",
                    payload.len()
                ),
            )
        })?;
        self.file.write_all(&length.to_be_bytes())?;
        self.file.write_all(payload)?;
        self.file.flush()
    }

    /// Read one frame, or `None` once the peer closed the channel.
    pub fn read_frame(&mut self) -> Result<Option<Vec<u8>>> {
        let mut header = [0u8; PREFIX_BYTES];
        let mut filled = 0;
        while filled < header.len() {
            match self.file.read(&mut header[filled..]) {
                Ok(0) => return Ok(None),
                Ok(bytes) => filled += bytes,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
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
