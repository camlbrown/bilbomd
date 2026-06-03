import { useState } from 'react'
import { Box, Button, Typography, Alert, Stack } from '@mui/material'
import DownloadIcon from '@mui/icons-material/Download'
import TableChartIcon from '@mui/icons-material/TableChart'
import { axiosInstance } from 'app/api/axios'
import { useSelector } from 'react-redux'
import { selectCurrentToken } from 'slices/authSlice'
import type { CarbonaraAnalysisPrediction } from 'slices/jobsApiSlice'

const buildMetricsCsv = (predictions: CarbonaraAnalysisPrediction[]): string => {
  const header = 'id,chi2,rg,rmsd_to_original,tm_to_original'
  const rows = predictions.map(
    (p) =>
      `${p.id},${p.chi2},${p.rg},${p.rmsd_to_original},${p.tm_to_original}`
  )
  return [header, ...rows].join('\n')
}

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

interface CarbonaraDownloadPanelProps {
  jobId: string
  mongoId: string
  predictions: CarbonaraAnalysisPrediction[]
}

const CarbonaraDownloadPanel = ({
  jobId,
  mongoId,
  predictions
}: CarbonaraDownloadPanelProps) => {
  const token = useSelector(selectCurrentToken)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const handleDownloadArchive = async () => {
    setDownloadError(null)
    setDownloading(true)
    try {
      const response = await axiosInstance.get(`jobs/${mongoId}/results`, {
        responseType: 'blob',
        headers: { Authorization: `Bearer ${token}` }
      })
      if (response?.data) {
        const contentDisposition = response.headers['content-disposition'] as
          | string
          | undefined
        let filename = 'carbonara_results.tar.gz'
        if (contentDisposition) {
          const m = /filename="?([^"]+)"?/.exec(contentDisposition)
          if (m?.[1]) filename = m[1]
        }
        downloadBlob(response.data as Blob, filename)
      } else {
        setDownloadError('No data received. Try again or contact support.')
      }
    } catch {
      setDownloadError('Download failed. The archive may not be ready yet.')
    } finally {
      setDownloading(false)
    }
  }

  const handleDownloadMetricsCsv = () => {
    const csv = buildMetricsCsv(predictions)
    const blob = new Blob([csv], { type: 'text/csv' })
    downloadBlob(blob, `carbonara_metrics_${jobId.slice(0, 8)}.csv`)
  }

  return (
    <Box>
      {downloadError && (
        <Alert
          severity="error"
          onClose={() => setDownloadError(null)}
          sx={{ mb: 1 }}
        >
          {downloadError}
        </Alert>
      )}
      <Stack
        direction="row"
        spacing={1}
        sx={{ flexWrap: 'wrap' }}
        useFlexGap
      >
        <Button
          variant="contained"
          startIcon={<DownloadIcon />}
          onClick={() => void handleDownloadArchive()}
          disabled={downloading}
        >
          {downloading ? 'Downloading…' : 'Download Results (tar.gz)'}
        </Button>
        <Button
          variant="outlined"
          startIcon={<TableChartIcon />}
          onClick={handleDownloadMetricsCsv}
          disabled={predictions.length === 0}
        >
          Metrics CSV
        </Button>
      </Stack>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ mt: 0.5, display: 'block' }}
      >
        The tar.gz archive contains AA PDB models, FoXS fit files, convergence
        logs, and the full analysis.json. The CSV contains per-prediction χ²,
        Rg, RMSD, and TM-score.
      </Typography>
    </Box>
  )
}

export default CarbonaraDownloadPanel
